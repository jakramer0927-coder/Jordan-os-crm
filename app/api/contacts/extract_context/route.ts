import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

export const runtime = "nodejs";

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

async function openaiExtract(system: string, user: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    }),
  });

  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || `OpenAI error (${res.status})`);
  const text = j?.choices?.[0]?.message?.content;
  if (typeof text === "string" && text.trim()) return text.trim();
  throw new Error("OpenAI returned no text");
}

export async function POST(req: Request) {
  const uid = await getVerifiedUid();
  if (!uid) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const { contact_id } = body;

  if (!isUuid(contact_id)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 });

  // Fetch contact
  const { data: contact, error: cErr } = await supabaseAdmin
    .from("contacts")
    .select("id, display_name, category, tier, client_type, company, notes, user_id")
    .eq("id", contact_id)
    .eq("user_id", uid)
    .single();

  if (cErr || !contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

  // Fetch text messages
  const { data: messages } = await supabaseAdmin
    .from("text_messages")
    .select("direction, body, occurred_at, created_at")
    .eq("contact_id", contact_id)
    .order("created_at", { ascending: false })
    .limit(200);

  // Fetch touch history with summaries
  const { data: touches } = await supabaseAdmin
    .from("touches")
    .select("direction, channel, occurred_at, intent, summary")
    .eq("contact_id", contact_id)
    .order("occurred_at", { ascending: false })
    .limit(50);

  const hasMessages = (messages ?? []).length > 0;
  const hasTouches = (touches ?? []).filter((t: any) => t.summary).length > 0;

  if (!hasMessages && !hasTouches) {
    return NextResponse.json({ error: "No messages or touch notes to extract from" }, { status: 400 });
  }

  const system = `You are extracting relationship intelligence from conversation history for a luxury Los Angeles real estate advisor named Jordan Kramer.

Your job: read the messages and touch notes, then produce a concise, factual summary of what matters for the relationship.

Output format — use these sections (omit any section with nothing to say):

**Real estate context**
What they're looking for, areas of interest, price range, timeline, buyer/seller status, specific properties discussed, deal status.

**Personal context**
Family details, job/company, life events mentioned, interests, anything personal that helps Jordan connect.

**Key discussions**
Notable topics, decisions made, commitments from either side, things they specifically asked for or mentioned.

**Follow-ups**
Any open items, things promised, things to ask about next time.

Rules:
- Only state facts found in the data. Never invent or infer beyond what's there.
- Be concise. Use bullet points within each section.
- If a section has nothing relevant, skip it entirely.
- Do not include filler or meta-commentary. Output only the extracted content.`;

  const msgBlock = (messages ?? [])
    .slice(0, 150)
    .reverse()
    .map((m: any) => `[${m.direction === "outbound" ? "Jordan" : contact.display_name}] ${m.body}`)
    .join("\n");

  const touchBlock = (touches ?? [])
    .filter((t: any) => t.summary)
    .map((t: any) => `${t.occurred_at?.slice(0, 10) ?? "?"} via ${t.channel} (${t.intent ?? "—"}): ${t.summary}`)
    .join("\n");

  const user = [
    `Contact: ${contact.display_name}`,
    `Category: ${contact.category}${contact.tier ? ` · Tier ${contact.tier}` : ""}${contact.client_type ? ` · ${contact.client_type}` : ""}`,
    contact.company ? `Company: ${contact.company}` : "",
    "",
    hasMessages ? `--- TEXT MESSAGES (oldest → newest) ---\n${msgBlock}` : "",
    hasTouches ? `--- TOUCH NOTES ---\n${touchBlock}` : "",
  ].filter(Boolean).join("\n");

  let extracted: string;
  try {
    extracted = await openaiExtract(system, user);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Extraction failed" }, { status: 500 });
  }

  // Save to contact
  const { error: uErr } = await supabaseAdmin
    .from("contacts")
    .update({
      ai_context: extracted,
      ai_context_updated_at: new Date().toISOString(),
    })
    .eq("id", contact_id);

  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    contact_id,
    ai_context: extracted,
    sources: {
      messages: (messages ?? []).length,
      touch_notes: (touches ?? []).filter((t: any) => t.summary).length,
    },
  });
}
