import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { syncFollowUpEvent } from "@/lib/followUpCalendar";

export const runtime = "nodejs";

// POST /api/capture — token-authed quick capture for iOS Shortcuts / external clients.
// Accepts a raw free-text note WITHOUT a contact_id ("Talked to Erick about the
// Sherman Oaks lot..."), matches the contact by name against the active book,
// then runs the same extraction pipeline as /api/interaction-notes/extract:
// interaction_note + touch + follow_ups + contact flag updates.
//
// Auth: Authorization: Bearer ${CAPTURE_SECRET}
// User: resolved from JORDAN_OS_USER_ID (single-tenant).

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!process.env.CAPTURE_SECRET || authHeader !== `Bearer ${process.env.CAPTURE_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const uid = process.env.JORDAN_OS_USER_ID;
  if (!uid) return NextResponse.json({ error: "Missing JORDAN_OS_USER_ID" }, { status: 500 });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "Missing ANTHROPIC_API_KEY" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const raw_text = String(body.text ?? "").trim();
  if (!raw_text) return NextResponse.json({ error: "text required" }, { status: 400 });

  try {
    // Active book is small (~300) — give the model the full name list to match against
    const { data: contacts, error: cErr } = await supabaseAdmin
      .from("contacts")
      .select("id, display_name, life_event_flags, referral_signal_active")
      .eq("user_id", uid)
      .eq("archived", false);
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });

    const nameToContact = new Map(
      (contacts ?? []).map((c: any) => [c.display_name.toLowerCase().trim(), c])
    );

    const prompt = `You are processing a real estate agent's quick voice/text note about a client interaction.
Return ONLY valid JSON. No preamble, no markdown.

The note refers to ONE contact. Match them against this list of the agent's contacts (exact names):
${(contacts ?? []).map((c: any) => c.display_name).join("\n")}

Raw note:
"""
${raw_text}
"""

Return this exact JSON structure:
{
  "matched_name": "exact name from the list above, or null if no confident match",
  "match_alternatives": ["up to 3 plausible names from the list if ambiguous, else empty array"],
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
}

Matching rules: first names alone are fine if only one contact plausibly matches ("Erick" → "Erick Zumwalt"). If two or more contacts could match, set matched_name to null and list them in match_alternatives.`;

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
      const match = rawOutput.match(/\{[\s\S]*\}/);
      if (match) extracted = JSON.parse(match[0]);
    }

    const matched = extracted.matched_name
      ? nameToContact.get(String(extracted.matched_name).toLowerCase().trim())
      : null;

    if (!matched) {
      return NextResponse.json({
        matched: false,
        message: extracted.match_alternatives?.length
          ? `Ambiguous — could be: ${extracted.match_alternatives.join(", ")}. Redo the note with a full name.`
          : "No contact matched. Redo the note with a full name.",
        alternatives: extracted.match_alternatives ?? [],
      }, { status: 422 });
    }

    const contact_id = matched.id;

    // Save raw note
    const { data: noteRow, error: insertErr } = await supabaseAdmin
      .from("interaction_notes")
      .insert({
        contact_id,
        raw_text,
        matched_by: "capture",
        summary: extracted.summary ?? null,
        topics_discussed: extracted.topics_discussed ?? [],
        sentiment: extracted.sentiment ?? null,
        life_event_flags: extracted.life_event_flags ?? [],
        action_items: extracted.action_items ?? [],
        referral_signal: extracted.referral_signal ?? false,
        referral_signal_note: extracted.referral_signal_note ?? null,
        transaction_intent: extracted.transaction_intent ?? null,
        timeline_mentioned: extracted.timeline_mentioned ?? null,
      })
      .select("id")
      .single();
    if (insertErr || !noteRow) return NextResponse.json({ error: insertErr?.message ?? "Insert failed" }, { status: 500 });

    // Touch — keeps cadence current (DB trigger updates last_contact_at/next_touch_due_at)
    const touchIntent = extracted.intent ?? "check_in";
    await supabaseAdmin.from("touches").insert({
      contact_id,
      channel: extracted.channel ?? "other",
      direction: extracted.direction ?? "outbound",
      intent: touchIntent,
      occurred_at: new Date().toISOString(),
      summary: (extracted.summary ?? raw_text.slice(0, 500)) || null,
      source: "capture",
      outcome: touchIntent === "referral_ask" ? "pending" : null,
    });

    // Action items → follow_ups (due tomorrow)
    const actionItems: string[] = Array.isArray(extracted.action_items)
      ? extracted.action_items.filter((s: any) => typeof s === "string" && s.trim())
      : [];
    if (actionItems.length > 0) {
      const due = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const { data: createdFus } = await supabaseAdmin.from("follow_ups").insert(
        actionItems.map((item) => ({
          user_id: uid,
          contact_id,
          due_date: due,
          note: item.trim().slice(0, 500),
        }))
      ).select("id, note");
      for (const fu of createdFus ?? []) {
        const eventId = await syncFollowUpEvent({
          uid, followUpId: (fu as any).id, contactId: contact_id, dueDate: due, note: (fu as any).note,
        });
        if (eventId) await supabaseAdmin.from("follow_ups").update({ gcal_event_id: eventId }).eq("id", (fu as any).id);
      }
    }

    // Contact flag updates
    const existingFlags: string[] = matched.life_event_flags ?? [];
    const newFlags: string[] = extracted.life_event_flags ?? [];
    const mergedFlags = Array.from(new Set([...existingFlags, ...newFlags]));
    await supabaseAdmin.from("contacts").update({
      last_interaction_at: new Date().toISOString(),
      life_event_flags: mergedFlags,
      ...(extracted.referral_signal ? { referral_signal_active: true } : {}),
    }).eq("id", contact_id);

    return NextResponse.json({
      matched: true,
      contact: matched.display_name,
      summary: extracted.summary ?? null,
      channel: extracted.channel ?? "other",
      follow_ups_created: actionItems.length,
      referral_signal: !!extracted.referral_signal,
      note_id: noteRow.id,
    });
  } catch (e: any) {
    console.error("CAPTURE_CRASH", e);
    return NextResponse.json({ error: e?.message ?? "Capture failed" }, { status: 500 });
  }
}
