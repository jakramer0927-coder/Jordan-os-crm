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

    // Fetch events from the past N days up to today
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

    // Get all contacts for this user with emails
    const { data: contacts } = await supabaseAdmin
      .from("contacts")
      .select("id, email")
      .eq("user_id", uid)
      .not("email", "is", null);

    const emailToContactId = new Map<string, string>();
    for (const c of contacts ?? []) {
      if (c.email) emailToContactId.set(c.email.toLowerCase().trim(), c.id);
    }

    let imported = 0;
    let skipped = 0;

    for (const event of events) {
      // Skip all-day events (no time component)
      if (!event.start?.dateTime) continue;
      // Skip cancelled events
      if (event.status === "cancelled") continue;
      // Skip events the user declined
      const mySelf = event.attendees?.find((a) => a.self);
      if (mySelf && mySelf.responseStatus === "declined") continue;

      const occurredAt = event.start.dateTime;
      const summary = event.summary?.trim() || "Meeting";

      // Find attendees that match contacts (exclude self)
      const attendeeEmails = (event.attendees ?? [])
        .filter((a) => !a.self)
        .map((a) => a.email?.toLowerCase() ?? "")
        .filter(Boolean);

      const matchedContactIds = new Set<string>();
      for (const email of attendeeEmails) {
        const cid = emailToContactId.get(email);
        if (cid) matchedContactIds.add(cid);
      }

      if (matchedContactIds.size === 0) { skipped++; continue; }

      for (const contactId of matchedContactIds) {
        // Dedupe: skip if a meeting touch already exists within 30 min of this event
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
        });
        imported++;
      }
    }

    // Update last_calendar_sync_at
    await supabaseAdmin
      .from("user_settings")
      .upsert({ user_id: uid, last_calendar_sync_at: new Date().toISOString() }, { onConflict: "user_id" });

    return NextResponse.json({ ok: true, imported, skipped, events_scanned: events.length });
  } catch (e) {
    return serverError("CALENDAR_SYNC_CRASH", e);
  }
}
