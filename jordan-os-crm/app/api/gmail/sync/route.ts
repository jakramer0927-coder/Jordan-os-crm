import { NextResponse } from "next/server";
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function safeErr(e: unknown) {
  const anyE = e as { message?: unknown; name?: unknown; stack?: unknown };
  return {
    message: String(anyE?.message || e || "Unknown error"),
    name: String(anyE?.name || ""),
    stack: typeof anyE?.stack === "string" ? anyE.stack.split("\n").slice(0, 12).join("\n") : "",
  };
}

function parseEmails(headerVal?: string): string[] {
  if (!headerVal) return [];
  const matches = headerVal.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return (matches ?? []).map((e) => e.toLowerCase().trim());
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const found = headers.find((h) => (h.name || "").toLowerCase() === name.toLowerCase());
  return found?.value || undefined;
}

type GoogleTokenRow = {
  access_token: string | null;
  refresh_token: string | null;
  expiry_date: number | null;
};

type UserSettingsRow = {
  gmail_label_names: string | null;
};

type ContactEmailRow = {
  contact_id: string;
  email: string;
};

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const uid = url.searchParams.get("uid") || "";
    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });

    if (!process.env.SUPABASE_URL) return NextResponse.json({ error: "Missing SUPABASE_URL" }, { status: 500 });
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
      return NextResponse.json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
    if (!process.env.GOOGLE_CLIENT_ID) return NextResponse.json({ error: "Missing GOOGLE_CLIENT_ID" }, { status: 500 });
    if (!process.env.GOOGLE_CLIENT_SECRET)
      return NextResponse.json({ error: "Missing GOOGLE_CLIENT_SECRET" }, { status: 500 });

    const { data: tok, error: tokErr } = await supabaseAdmin
      .from("google_tokens")
      .select("access_token, refresh_token, expiry_date")
      .eq("user_id", uid)
      .single();

    if (tokErr || !tok) return NextResponse.json({ error: "Google not connected" }, { status: 400 });

    const tokenRow = tok as GoogleTokenRow;
    if (!tokenRow.refresh_token) {
      return NextResponse.json({ error: "Missing refresh token (reconnect Google)" }, { status: 400 });
    }

    const { data: settings, error: setErr } = await supabaseAdmin
      .from("user_settings")
      .select("gmail_label_names")
      .eq("user_id", uid)
      .maybeSingle();

    if (setErr) return NextResponse.json({ error: setErr.message }, { status: 500 });

    const sRow = settings as UserSettingsRow | null;

    const labelNames = (sRow?.gmail_label_names || "")
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    if (labelNames.length === 0) {
      return NextResponse.json({ error: "No Gmail labels configured in settings." }, { status: 400 });
    }

    const oauth2 = getGoogleOAuthClient();
    oauth2.setCredentials({
      access_token: tokenRow.access_token ?? undefined,
      refresh_token: tokenRow.refresh_token ?? undefined,
      expiry_date: tokenRow.expiry_date ?? undefined,
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    // Map label names -> label IDs
    const labelsRes = await gmail.users.labels.list({ userId: "me" });
    const labels = labelsRes.data.labels ?? [];

    const labelIdByName = new Map<string, string>();
    labels.forEach((l: gmail_v1.Schema$Label) => {
      const name = l.name || "";
      const id = l.id || "";
      if (name && id) labelIdByName.set(name, id);
    });

    const labelIds = labelNames
      .map((n: string) => labelIdByName.get(n))
      .filter((x: string | undefined): x is string => typeof x === "string" && x.length > 0);

    if (labelIds.length === 0) {
      return NextResponse.json(
        { error: `None of the configured labels were found in Gmail. Configured: ${labelNames.join(", ")}` },
        { status: 400 }
      );
    }

    // Load contact emails
    const { data: ce, error: ceErr } = await supabaseAdmin
      .from("contact_emails")
      .select("contact_id, email")
      .limit(50000);

    if (ceErr) return NextResponse.json({ error: ceErr.message }, { status: 500 });

    const contactIdByEmail = new Map<string, string>();
    (ce ?? []).forEach((row) => {
      const r = row as ContactEmailRow;
      const e = (r.email || "").toLowerCase().trim();
      if (e) contactIdByEmail.set(e, r.contact_id);
    });

    // Counters
    let scanned = 0;
    let imported = 0;
    let unmatched = 0;

    let skipped_existing_message_id = 0;
    let skipped_existing_occurred_at = 0;
    let skipped_insert_error = 0;
    let skipped_lookup_error = 0;

    // Store a few insert errors for debugging (don’t spam response)
    const insertErrorSamples: Array<{ messageId: string; contactId: string; error: string }> = [];

    let pageToken: string | undefined = undefined;
    const maxToScan = 500;

    while (scanned < maxToScan) {
      const listRes: gmail_v1.Schema$ListMessagesResponse =
        (
          await gmail.users.messages.list({
            userId: "me",
            labelIds: [...labelIds, "SENT"],
            maxResults: Math.min(100, maxToScan - scanned),
            pageToken,
          })
        ).data;

      const msgs = listRes.messages ?? [];
      pageToken = listRes.nextPageToken ?? undefined;

      if (msgs.length === 0) break;

      for (const m of msgs) {
        if (!m.id) continue;
        scanned += 1;

        const full = await gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "metadata",
          metadataHeaders: ["To", "Cc", "Bcc", "Subject", "Date"],
        });

        const headers = full.data.payload?.headers ?? [];
        const toEmails = parseEmails(headerValue(headers, "To"));
        const ccEmails = parseEmails(headerValue(headers, "Cc"));
        const bccEmails = parseEmails(headerValue(headers, "Bcc"));
        const allRecipients = Array.from(new Set([...toEmails, ...ccEmails, ...bccEmails]));

        const subject = headerValue(headers, "Subject") || "";
        const internalDateMs = Number(full.data.internalDate || 0);
        const occurredAt = internalDateMs ? new Date(internalDateMs).toISOString() : new Date().toISOString();
        const snippet = (full.data.snippet || "").trim();

        const matchedEmail = allRecipients.find((e: string) => contactIdByEmail.has(e));
        if (!matchedEmail) {
          unmatched += 1;
          continue;
        }

        const contactId = contactIdByEmail.get(matchedEmail);
        if (!contactId) {
          unmatched += 1;
          continue;
        }

        const threadId = full.data.threadId || "";
        const link: string | null = threadId ? `https://mail.google.com/mail/u/0/#all/${threadId}` : null;

        const messageId = m.id;
        const summary = (snippet || subject).trim() || null;

        // De-dupe 1: messageId
        const { data: ex1, error: ex1Err } = await supabaseAdmin
          .from("touches")
          .select("id")
          .eq("contact_id", contactId)
          .eq("source", "gmail")
          .eq("source_message_id", messageId)
          .limit(1);

        if (ex1Err) {
          skipped_lookup_error += 1;
          continue;
        }

        if ((ex1 ?? []).length > 0) {
          skipped_existing_message_id += 1;
          continue;
        }

        // De-dupe 2: occurred_at (fallback)
        const { data: ex2, error: ex2Err } = await supabaseAdmin
          .from("touches")
          .select("id")
          .eq("contact_id", contactId)
          .eq("source", "gmail")
          .eq("occurred_at", occurredAt)
          .limit(1);

        if (ex2Err) {
          skipped_lookup_error += 1;
          continue;
        }

        if ((ex2 ?? []).length > 0) {
          skipped_existing_occurred_at += 1;
          continue;
        }

        // Insert
        const { error: insErr } = await supabaseAdmin.from("touches").insert({
          contact_id: contactId,
          channel: "email",
          direction: "outbound",
          occurred_at: occurredAt,
          intent: "check_in",
          summary,
          source: "gmail",
          source_link: link,
          source_message_id: messageId,
        });

        if (insErr) {
          skipped_insert_error += 1;
          if (insertErrorSamples.length < 5) {
            insertErrorSamples.push({
              messageId,
              contactId,
              error: insErr.message,
            });
          }
          continue;
        }

        imported += 1;
      }

      if (!pageToken) break;
    }

    const skipped =
      skipped_existing_message_id + skipped_existing_occurred_at + skipped_insert_error + skipped_lookup_error;

    return NextResponse.json({
      scanned,
      imported,
      skipped,
      skipped_existing_message_id,
      skipped_existing_occurred_at,
      skipped_insert_error,
      skipped_lookup_error,
      unmatched,
      labelsUsed: labelNames,
      insertErrorSamples,
      note: "Matches recipients against contact_emails; imports outbound (SENT) only.",
    });
  } catch (e) {
    const se = safeErr(e);
    console.error("GMAIL_SYNC_CRASH", se);
    return NextResponse.json(
      {
        error: "Gmail sync crashed",
        details: se,
        details_message: se.message,
        details_json: JSON.stringify(se),
      },
      { status: 500 }
    );
  }
}