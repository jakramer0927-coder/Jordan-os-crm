import { NextResponse } from "next/server";
import { google } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

function parseEmails(val?: string | null): string[] {
  if (!val) return [];
  const matches = val.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return (matches ?? []).map((e) => e.toLowerCase().trim());
}

export async function GET(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const url = new URL(req.url);
    const resetSync = url.searchParams.get("reset") === "true";

    const { data: tok, error: tokErr } = await supabaseAdmin
      .from("google_tokens")
      .select("access_token, refresh_token, expiry_date")
      .eq("user_id", uid)
      .single();

    if (tokErr || !tok) return NextResponse.json({ error: "Google not connected" }, { status: 400 });
    if (!tok.refresh_token) return NextResponse.json({ error: "Missing refresh token (reconnect Google)" }, { status: 400 });

    const { data: settings } = await supabaseAdmin
      .from("user_settings")
      .select("last_calendar_sync_at")
      .eq("user_id", uid)
      .maybeSingle();

    if (resetSync) {
      await supabaseAdmin
        .from("user_settings")
        .upsert({ user_id: uid, last_calendar_sync_at: null }, { onConflict: "user_id" });
    }

    const lastSyncAt = resetSync ? null : (settings?.last_calendar_sync_at ?? null);
    const afterDate = lastSyncAt
      ? new Date(lastSyncAt)
      : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const oauth2 = getGoogleOAuthClient();
    oauth2.setCredentials({
      access_token: tok.access_token ?? undefined,
      refresh_token: tok.refresh_token ?? undefined,
      expiry_date: tok.expiry_date ?? undefined,
    });

    const calendar = google.calendar({ version: "v3", auth: oauth2 });

    // Get user's own email to exclude self from attendee matching
    const gmail = google.gmail({ version: "v1", auth: oauth2 });
    let ownEmail = "";
    try {
      const profile = await gmail.users.getProfile({ userId: "me" });
      ownEmail = (profile.data.emailAddress || "").toLowerCase();
    } catch { /* ignore */ }

    // Load contact emails for this user
    const { data: userContacts } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("user_id", uid)
      .eq("archived", false);

    const userContactIds = (userContacts ?? []).map((c: any) => c.id as string);
    const contactIdByEmail = new Map<string, string>();

    if (userContactIds.length > 0) {
      const { data: ce } = await supabaseAdmin
        .from("contact_emails")
        .select("contact_id, email")
        .in("contact_id", userContactIds);

      (ce ?? []).forEach((row: any) => {
        const e = (row.email || "").toLowerCase().trim();
        if (e) contactIdByEmail.set(e, row.contact_id);
      });
    }

    let imported = 0;
    let skipped = 0;
    let pageToken: string | undefined;
    const MAX_EVENTS = 500;
    let fetched = 0;

    while (fetched < MAX_EVENTS) {
      const res = await calendar.events.list({
        calendarId: "primary",
        timeMin: afterDate.toISOString(),
        maxResults: Math.min(250, MAX_EVENTS - fetched),
        singleEvents: true,
        orderBy: "startTime",
        pageToken,
        fields: "nextPageToken,items(id,summary,status,start,end,attendees,hangoutLink,htmlLink)",
      });

      const events = res.data.items ?? [];
      pageToken = res.data.nextPageToken ?? undefined;
      if (events.length === 0) break;
      fetched += events.length;

      for (const event of events) {
        // Skip cancelled events
        if (event.status === "cancelled") continue;

        // Skip all-day events (no time component)
        if (!event.start?.dateTime) continue;

        const attendees = event.attendees ?? [];

        // Skip if you declined
        const selfAttendee = attendees.find((a) =>
          (a.email || "").toLowerCase() === ownEmail
        );
        if (selfAttendee?.responseStatus === "declined") continue;

        // Skip events with no other attendees
        const otherAttendees = attendees.filter(
          (a) => (a.email || "").toLowerCase() !== ownEmail
        );
        if (otherAttendees.length === 0) continue;

        // Find a matching contact among other attendees
        const matchedAttendee = otherAttendees.find((a) =>
          contactIdByEmail.has((a.email || "").toLowerCase())
        );
        if (!matchedAttendee) continue;

        const contactId = contactIdByEmail.get((matchedAttendee.email || "").toLowerCase());
        if (!contactId) continue;

        const occurredAt = new Date(event.start.dateTime).toISOString();
        const eventId = event.id ?? "";
        const title = event.summary || null;
        const link = event.htmlLink || event.hangoutLink || null;

        // Dedupe by source_message_id (reuse field for event ID)
        const { data: existing } = await supabaseAdmin
          .from("touches")
          .select("id")
          .eq("contact_id", contactId)
          .eq("source", "calendar")
          .eq("source_message_id", eventId)
          .limit(1);

        if ((existing ?? []).length > 0) { skipped++; continue; }

        const { error: insErr } = await supabaseAdmin.from("touches").insert({
          contact_id: contactId,
          channel: "in_person",
          direction: "outbound",
          occurred_at: occurredAt,
          intent: "check_in",
          summary: title,
          source: "calendar",
          source_link: link,
          source_message_id: eventId,
        });

        if (insErr) skipped++;
        else imported++;
      }

      if (!pageToken) break;
    }

    await supabaseAdmin
      .from("user_settings")
      .upsert({ user_id: uid, last_calendar_sync_at: new Date().toISOString() }, { onConflict: "user_id" });

    return NextResponse.json({ imported, skipped, eventsFetched: fetched });
  } catch (e) {
    return serverError("CALENDAR_SYNC_CRASH", e);
  }
}
