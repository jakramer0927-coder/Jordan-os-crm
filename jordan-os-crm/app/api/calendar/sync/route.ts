import { NextResponse } from "next/server";
import { google } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";
import { decryptToken } from "@/lib/tokenCrypto";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const days = Number(body.days ?? 90);

    // Load Google token
    const { data: tokenRow, error: tErr } = await supabaseAdmin
      .from("google_tokens")
      .select("access_token, refresh_token, expiry_date")
      .eq("user_id", uid)
      .maybeSingle();

    if (tErr || !tokenRow?.refresh_token) {
      return NextResponse.json({ error: "Google account not connected" }, { status: 400 });
    }

    const auth = getGoogleOAuthClient();
    auth.setCredentials({
      access_token: tokenRow.access_token ? decryptToken(tokenRow.access_token) : undefined,
      refresh_token: tokenRow.refresh_token ? decryptToken(tokenRow.refresh_token) : undefined,
      expiry_date: tokenRow.expiry_date ?? undefined,
    });

    const calendar = google.calendar({ version: "v3", auth });

    const timeMin = new Date(Date.now() - days * 86400000).toISOString();
    const timeMax = new Date().toISOString();

    const eventsRes = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      maxResults: 500,
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = eventsRes.data.items ?? [];

    // Build email→contactId from primary emails
    const { data: contacts } = await supabaseAdmin
      .from("contacts")
      .select("id, email")
      .eq("user_id", uid)
      .not("email", "is", null);

    const emailToContactId = new Map<string, string>();
    for (const c of contacts ?? []) {
      if (c.email) emailToContactId.set(c.email.toLowerCase().trim(), c.id);
    }

    // Also pull from contact_emails table (multiple emails per contact)
    const { data: extraEmails } = await supabaseAdmin
      .from("contact_emails")
      .select("contact_id, email")
      .eq("user_id", uid);

    for (const row of extraEmails ?? []) {
      if (row.email && !emailToContactId.has(row.email.toLowerCase().trim())) {
        emailToContactId.set(row.email.toLowerCase().trim(), row.contact_id);
      }
    }

    let imported = 0;
    let skipped = 0;
    let unmatchedQueued = 0;

    for (const event of events) {
      if (!event.start?.dateTime) continue;
      if (event.status === "cancelled") continue;
      const mySelf = event.attendees?.find((a) => a.self);
      if (mySelf && mySelf.responseStatus === "declined") continue;

      const occurredAt = event.start.dateTime;
      const summary = event.summary?.trim() || "Meeting";
      const googleEventId = event.id ?? null;

      const nonSelfAttendees = (event.attendees ?? []).filter((a) => !a.self);

      // If no attendees at all, skip silently (solo blocks)
      if (nonSelfAttendees.length === 0) { skipped++; continue; }

      const attendeeEmails = nonSelfAttendees
        .map((a) => a.email?.toLowerCase() ?? "")
        .filter(Boolean);

      const matchedContactIds = new Set<string>();
      for (const email of attendeeEmails) {
        const cid = emailToContactId.get(email);
        if (cid) matchedContactIds.add(cid);
      }

      if (matchedContactIds.size === 0) {
        // No CRM match — add to review queue
        if (googleEventId) {
          const attendeeNames = nonSelfAttendees
            .map((a) => a.displayName || a.email || "")
            .filter(Boolean);

          await supabaseAdmin
            .from("calendar_review_queue")
            .upsert(
              {
                user_id: uid,
                google_event_id: googleEventId,
                event_title: summary,
                occurred_at: occurredAt,
                attendee_emails: attendeeEmails,
                attendee_names: attendeeNames,
                dismissed: false,
              },
              { onConflict: "user_id,google_event_id", ignoreDuplicates: true }
            );
          unmatchedQueued++;
        }
        skipped++;
        continue;
      }

      for (const contactId of matchedContactIds) {
        const windowStart = new Date(new Date(occurredAt).getTime() - 30 * 60000).toISOString();
        const windowEnd = new Date(new Date(occurredAt).getTime() + 30 * 60000).toISOString();

        const { data: existing } = await supabaseAdmin
          .from("touches")
          .select("id")
          .eq("contact_id", contactId)
          .eq("channel", "meeting")
          .eq("source", "calendar")
          .gte("occurred_at", windowStart)
          .lte("occurred_at", windowEnd)
          .limit(1);

        if (existing && existing.length > 0) { skipped++; continue; }

        await supabaseAdmin.from("touches").insert({
          contact_id: contactId,
          channel: "meeting",
          direction: "outbound",
          occurred_at: occurredAt,
          summary,
          source: "calendar",
          user_id: uid,
        });
        imported++;
      }
    }

    await supabaseAdmin
      .from("user_settings")
      .upsert({ user_id: uid, last_calendar_sync_at: new Date().toISOString() }, { onConflict: "user_id" });

    return NextResponse.json({ ok: true, imported, skipped, events_scanned: events.length, unmatched_queued: unmatchedQueued });
  } catch (e) {
    return serverError("CALENDAR_SYNC_CRASH", e);
  }
}
