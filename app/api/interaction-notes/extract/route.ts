import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { contact_id, raw_text, direction: directionOverride } = body;

    if (!contact_id) return NextResponse.json({ error: "contact_id required" }, { status: 400 });
    if (!raw_text?.trim()) return NextResponse.json({ error: "raw_text required" }, { status: 400 });

    // Verify contact belongs to this user
    const { data: owned } = await supabaseAdmin
      .from("contacts")
      .select("id, life_event_flags, referral_signal_active")
      .eq("id", contact_id)
      .eq("user_id", uid)
      .single();
    if (!owned) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

    // Save raw note immediately
    const { data: noteRow, error: insertErr } = await supabaseAdmin
      .from("interaction_notes")
      .insert({ contact_id, raw_text: raw_text.trim(), matched_by: "manual" })
      .select("id")
      .single();
    if (insertErr || !noteRow) return NextResponse.json({ error: insertErr?.message ?? "Insert failed" }, { status: 500 });

    const noteId = noteRow.id;

    // Call Claude to extract structured data
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "Missing ANTHROPIC_API_KEY" }, { status: 500 });

    const prompt = `You are extracting structured data from a real estate agent's interaction note.
Return ONLY valid JSON. No preamble, no markdown, no explanation.

Raw note:
"""
${raw_text.trim()}
"""

Return this exact JSON structure:
{
  "channel": "text | call | email | in_person | social_dm | other",
  "direction": "outbound | inbound",
  "intent": "check_in | referral_ask | review_ask | deal_followup | collaboration | event_invite | other",
  "summary": "2-3 sentence summary of the interaction",
  "topics_discussed": ["array of topics discussed"],
  "sentiment": "positive | neutral | negative | mixed",
  "life_event_flags": ["any life events mentioned — job change, new baby, divorce, death, relocation, marriage, retirement, inheritance — or empty array"],
  "action_items": ["specific follow-up tasks mentioned or implied — or empty array"],
  "referral_signal": true or false,
  "referral_signal_note": "why this is a referral signal, or null",
  "transaction_intent": "buying | selling | leasing | none | unclear",
  "timeline_mentioned": "any timeline or urgency mentioned, or null"
}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return NextResponse.json({ error: `Claude error: ${errText}` }, { status: 502 });
    }

    const claudeJson = await claudeRes.json();
    const rawOutput = claudeJson?.content?.[0]?.text ?? "";

    let extracted: any = {};
    try {
      extracted = JSON.parse(rawOutput);
    } catch {
      // Best-effort JSON extraction if wrapped in markdown
      const match = rawOutput.match(/\{[\s\S]*\}/);
      if (match) extracted = JSON.parse(match[0]);
    }

    // Update interaction_notes row with extracted fields
    await supabaseAdmin.from("interaction_notes").update({
      summary: extracted.summary ?? null,
      topics_discussed: extracted.topics_discussed ?? [],
      sentiment: extracted.sentiment ?? null,
      life_event_flags: extracted.life_event_flags ?? [],
      action_items: extracted.action_items ?? [],
      referral_signal: extracted.referral_signal ?? false,
      referral_signal_note: extracted.referral_signal_note ?? null,
      transaction_intent: extracted.transaction_intent ?? null,
      timeline_mentioned: extracted.timeline_mentioned ?? null,
    }).eq("id", noteId);

    // Insert a touches row so cadence tracking stays current
    const touchIntent = extracted.intent ?? "check_in";
    await supabaseAdmin.from("touches").insert({
      contact_id,
      channel: extracted.channel ?? "other",
      direction: directionOverride ?? extracted.direction ?? "outbound",
      intent: touchIntent,
      occurred_at: new Date().toISOString(),
      summary: (extracted.summary ?? raw_text.trim().slice(0, 500)) || null,
      source: "manual",
      outcome: touchIntent === "referral_ask" ? "pending" : null,
    });

    // Turn extracted action items into follow_ups so they surface on the
    // morning page instead of sitting unread on the note
    const actionItems: string[] = Array.isArray(extracted.action_items)
      ? extracted.action_items.filter((s: any) => typeof s === "string" && s.trim())
      : [];
    let followUpsCreated = 0;
    if (actionItems.length > 0) {
      // Default due tomorrow; timeline_mentioned stays on the note for context
      const due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const { error: fuErr } = await supabaseAdmin.from("follow_ups").insert(
        actionItems.map((item) => ({
          user_id: uid,
          contact_id,
          due_date: due,
          note: item.trim().slice(0, 500),
        }))
      );
      if (!fuErr) followUpsCreated = actionItems.length;
    }

    // Update contacts: last_interaction_at, life_event_flags (append unique), referral_signal_active
    const existingFlags: string[] = owned.life_event_flags ?? [];
    const newFlags: string[] = extracted.life_event_flags ?? [];
    const mergedFlags = Array.from(new Set([...existingFlags, ...newFlags]));

    await supabaseAdmin.from("contacts").update({
      last_interaction_at: new Date().toISOString(),
      life_event_flags: mergedFlags,
      ...(extracted.referral_signal ? { referral_signal_active: true } : {}),
    }).eq("id", contact_id);

    return NextResponse.json({ note_id: noteId, extracted, follow_ups_created: followUpsCreated });
  } catch (e) {
    return serverError("INTERACTION_EXTRACT_CRASH", e);
  }
}
