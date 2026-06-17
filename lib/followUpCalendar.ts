import { google } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";
import { decryptToken } from "@/lib/tokenCrypto";

// Pushes CRM to-dos (follow_ups) to the user's primary Google Calendar as
// all-day events on the due date, and keeps them in sync. Best-effort: a
// calendar failure never blocks the underlying to-do write.

async function calendarClient(uid: string) {
  const { data: tok } = await supabaseAdmin
    .from("google_tokens")
    .select("access_token, refresh_token, expiry_date")
    .eq("user_id", uid)
    .maybeSingle();
  if (!tok?.refresh_token && !tok?.access_token) return null;

  const auth = getGoogleOAuthClient();
  auth.setCredentials({
    access_token: tok.access_token ? decryptToken(tok.access_token) : undefined,
    refresh_token: tok.refresh_token ? decryptToken(tok.refresh_token) : undefined,
    expiry_date: tok.expiry_date ?? undefined,
  });
  return google.calendar({ version: "v3", auth });
}

function plusOneDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function eventTitle(contactName: string | null, note: string | null): string {
  const base = note?.trim() || "Follow up";
  return contactName ? `Follow up: ${contactName} — ${base}` : `Follow up: ${base}`;
}

/**
 * Create or update the calendar event for a follow-up. Returns the event id
 * (new or existing) so the caller can persist it on the follow_up row.
 */
export async function syncFollowUpEvent(opts: {
  uid: string;
  followUpId: string;
  contactId: string;
  dueDate: string;
  note: string | null;
  existingEventId?: string | null;
}): Promise<string | null> {
  try {
    const cal = await calendarClient(opts.uid);
    if (!cal) return opts.existingEventId ?? null;

    const { data: contact } = await supabaseAdmin
      .from("contacts").select("display_name").eq("id", opts.contactId).maybeSingle();

    const requestBody = {
      summary: eventTitle(contact?.display_name ?? null, opts.note),
      description: `Dex follow-up\nhttps://jordan-os-crm.vercel.app/contacts/${opts.contactId}`,
      start: { date: opts.dueDate },
      end: { date: plusOneDay(opts.dueDate) },
      transparency: "transparent" as const,
      reminders: { useDefault: false, overrides: [{ method: "popup" as const, minutes: 9 * 60 }] },
      source: { title: "Dex", url: `https://jordan-os-crm.vercel.app/contacts/${opts.contactId}` },
    };

    if (opts.existingEventId) {
      const res = await cal.events.update({
        calendarId: "primary",
        eventId: opts.existingEventId,
        requestBody,
      });
      return res.data.id ?? opts.existingEventId;
    }

    const res = await cal.events.insert({ calendarId: "primary", requestBody });
    return res.data.id ?? null;
  } catch {
    return opts.existingEventId ?? null;
  }
}

export async function deleteFollowUpEvent(uid: string, eventId: string | null | undefined): Promise<void> {
  if (!eventId) return;
  try {
    const cal = await calendarClient(uid);
    if (!cal) return;
    await cal.events.delete({ calendarId: "primary", eventId });
  } catch {
    // already gone / revoked — ignore
  }
}
