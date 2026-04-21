import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUser, unauthorized } from "@/lib/supabase/server";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

type Tip = { issue: string; recommendation: string; example?: string };

export async function POST(req: Request) {
  try {
    const user = await getVerifiedUser();
    if (!user) return unauthorized();

    const body = await req.json().catch(() => ({})) as { text?: string };
    const text = (body?.text || "").trim();

    if (!text || text.length < 10) return NextResponse.json({ observations: [], score: null });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });

    // Load coaching tips and agent name from user_settings
    const { data: settings } = await supabaseAdmin
      .from("user_settings")
      .select("voice_coaching_tips, voice_style_guide, agent_name")
      .eq("user_id", user.id)
      .maybeSingle();

    const tips: Tip[] = (settings as any)?.voice_coaching_tips || [];
    const styleGuide: string = (settings as any)?.voice_style_guide || "";
    const agentName = (settings as any)?.agent_name || user.name || user.email?.split("@")[0] || "this agent";

    if (tips.length === 0 && !styleGuide) {
      return NextResponse.json({
        observations: ["Run voice coaching first to get personalized feedback."],
        score: null,
      });
    }

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    const tipsSummary = tips.length > 0
      ? tips.map((t, i) => `${i + 1}. ${t.issue}: ${t.recommendation}`).join("\n")
      : "";

    const prompt = `You are reviewing an outbound message written by ${agentName}, a real estate professional.

${tipsSummary ? `${agentName}'s known improvement areas:\n${tipsSummary}\n` : ""}
${styleGuide ? `${agentName}'s style guide:\n${styleGuide}\n` : ""}

MESSAGE TO REVIEW:
"""
${text.slice(0, 1500)}
"""

Give 1-3 short, specific observations about this message. Focus on what aligns with or violates his improvement areas.
Be direct and constructive. Each observation should be 1 sentence max.
If the message is strong, say so briefly.

Return JSON: { "observations": ["...", "..."], "score": 1-10 }`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });

    const j = await res.json();
    if (!res.ok) return NextResponse.json({ observations: [], score: null });

    const parsed = JSON.parse(j?.choices?.[0]?.message?.content || "{}");
    return NextResponse.json({
      observations: parsed.observations || [],
      score: parsed.score || null,
    });
  } catch {
    return NextResponse.json({ observations: [], score: null });
  }
}
