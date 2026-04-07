import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rateLimit";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}


export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const limited = await checkRateLimit(uid, "voice_coach", 5);
    if (limited) return limited;

    // Pull a diverse sample of voice examples
    const { data, error } = await supabaseAdmin
      .from("user_voice_examples")
      .select("channel, intent, text, occurred_at")
      .eq("user_id", uid)
      .order("occurred_at", { ascending: false })
      .limit(50);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const examples = (data ?? [])
      .map((r: any) => (r.text || "").trim())
      .filter((t: string) => t.length >= 60);

    if (examples.length < 5) {
      return NextResponse.json({
        ok: false,
        error: "Not enough voice examples yet — sync Gmail sent emails first (need at least 5).",
      }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const sampleText = examples.slice(0, 30).map((t, i) => `--- Email ${i + 1} ---\n${t}`).join("\n\n");

    const system = `You are a communication coach specializing in outbound relationship management for luxury real estate advisors.
You analyze real email samples written by an advisor and provide honest, actionable feedback.
Be direct, specific, and constructive. Focus on what will actually improve conversion and relationship depth.
Format your response as valid JSON only — no markdown, no extra text outside the JSON object.`;

    const user = `Analyze the following outbound emails written by Jordan Kramer, a luxury Los Angeles real estate advisor.
His goal: stay top of mind with clients, agents, developers, and sphere contacts without being annoying or salesy.

EMAILS:
${sampleText}

Return a JSON object with exactly these fields:
{
  "style_summary": "2-3 sentence description of Jordan's current communication style — what's working and the overall tone",
  "strengths": ["3-4 specific things Jordan does well in his outreach"],
  "improvements": [
    {
      "issue": "specific problem observed",
      "recommendation": "concrete, actionable fix",
      "example": "before/after example if helpful"
    }
  ],
  "style_guide": "A compact 150-word writing guide in Jordan's voice, written as instructions for an AI that will draft emails on his behalf. Cover: tone, length, structure, what to avoid, signature phrases.",
  "score": {
    "warmth": 1-10,
    "clarity": 1-10,
    "brevity": 1-10,
    "relevance": 1-10,
    "overall": 1-10
  }
}

Provide 3-5 improvements. Be specific — reference actual patterns from the emails where possible.`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.3,
        response_format: { type: "json_object" },
      }),
    });

    const j = await res.json();
    if (!res.ok) {
      return NextResponse.json({ error: j?.error?.message || `OpenAI error ${res.status}` }, { status: 500 });
    }

    const raw = j?.choices?.[0]?.message?.content || "{}";
    const coaching = JSON.parse(raw);

    // Persist full coaching result + style guide + tips
    await supabaseAdmin
      .from("user_settings")
      .upsert({
        user_id: uid,
        voice_style_guide: coaching.style_guide || null,
        voice_coaching_tips: coaching.improvements || null,
        voice_coaching_result: coaching,
        voice_coached_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

    return NextResponse.json({
      ok: true,
      examples_analyzed: examples.length,
      coaching,
    });
  } catch (e) {
    return serverError("VOICE_COACH_CRASH", e);
  }
}
