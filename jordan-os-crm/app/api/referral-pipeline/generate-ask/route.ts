import { NextResponse } from "next/server";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const {
      display_name,
      category,
      last_interaction_summary,
      transaction_history,
      life_event_flags,
      last_referral_ask_date,
    } = body;

    if (!display_name) return NextResponse.json({ error: "display_name required" }, { status: 400 });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "Missing ANTHROPIC_API_KEY" }, { status: 500 });

    // Calculate months since last ask
    let monthsSinceLastAsk: string = "Never asked";
    if (last_referral_ask_date) {
      const months = Math.floor((Date.now() - new Date(last_referral_ask_date).getTime()) / (86400000 * 30));
      monthsSinceLastAsk = `${months} months ago`;
    }

    const nameParts = display_name.trim().split(" ");
    const firstName = nameParts[0] ?? display_name;
    const lastName = nameParts.slice(1).join(" ") || "";

    const prompt = `You are drafting a referral ask text message for Jordan, a luxury real estate agent in Los Angeles.

Contact context:
- Name: ${firstName} ${lastName}
- Relationship status: ${category ?? "Client"}
- Last interaction summary: ${last_interaction_summary ?? "No recent notes"}
- Transaction history: ${transaction_history ?? "None on record"}
- Life events on file: ${Array.isArray(life_event_flags) && life_event_flags.length > 0 ? life_event_flags.join(", ") : "None"}
- Months since last referral ask: ${monthsSinceLastAsk}

Write a 2-3 sentence text message that:
- Feels personal and specific to this person — reference something real if available
- Naturally asks if they know anyone thinking about buying, selling, or leasing
- Sounds like Jordan: direct, warm, professional — never salesy or pushy
- Does NOT use the phrases: "reach out", "hope this finds you well", "touching base", "circling back"
- Reads like a genuine human text, not a template

Return only the message text. Nothing else.`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return NextResponse.json({ error: `Claude error: ${errText}` }, { status: 502 });
    }

    const claudeJson = await claudeRes.json();
    const draft = claudeJson?.content?.[0]?.text?.trim() ?? "";

    return NextResponse.json({ draft });
  } catch (e) {
    return serverError("REFERRAL_GENERATE_ASK_CRASH", e);
  }
}
