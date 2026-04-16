import { NextResponse } from "next/server";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

const VALID_CHANNELS = ["text", "email", "call", "in_person", "social", "other"];

async function parseWithClaude(text: string, contactName?: string): Promise<{ channel: string; summary: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  const system = `You are a real estate CRM assistant. Parse a free-text note about a contact interaction and extract:
1. channel: the communication channel used (one of: text, email, call, in_person, social, other)
2. summary: a concise 1-sentence summary of what happened (max 120 chars, professional tone)

Return ONLY valid JSON like: {"channel":"in_person","summary":"Coffee meeting — thinking about listing in spring"}

Channel guidance:
- "call" = phone call, talked on phone, called, rang
- "text" = texted, SMS, messaged via phone
- "email" = emailed, sent email
- "in_person" = met, coffee, lunch, dinner, showed, showing, visited, saw in person
- "social" = LinkedIn, Instagram, Facebook, DM, social media
- "other" = anything unclear`;

  const userMsg = contactName
    ? `Contact: ${contactName}\nNote: ${text}`
    : `Note: ${text}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 256,
      temperature: 0,
      system,
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || `Anthropic error (${res.status})`);

  const raw = j?.content?.[0]?.text?.trim() ?? "";
  // Extract JSON from response (handles if model adds extra text)
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in response");

  const parsed = JSON.parse(match[0]);
  const channel = VALID_CHANNELS.includes(parsed.channel) ? parsed.channel : "other";
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 120) : "";

  return { channel, summary };
}

// POST /api/touches/parse
export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { text, contact_name } = body;

    if (!text?.trim()) {
      return NextResponse.json({ error: "text required" }, { status: 400 });
    }

    const result = await parseWithClaude(text.trim(), contact_name?.trim() || undefined);
    return NextResponse.json(result);
  } catch (e) {
    return serverError("TOUCHES_PARSE_CRASH", e);
  }
}
