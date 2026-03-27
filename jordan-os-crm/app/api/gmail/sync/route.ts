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

function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const found = headers.find((h) => (h.name || "").toLowerCase() === name.toLowerCase());
  return found?.value || undefined;
}

// Domains that generate transactional/automated email — never useful as unmatched contacts
const BUILTIN_IGNORE_DOMAINS = new Set([
  // Brokerages
  "compass.com", "elliman.com", "douglaselliman.com", "sothebysrealty.com",
  "corcoran.com", "kwrealty.com", "kw.com", "coldwellbanker.com", "bhhs.com",
  "berkshirehathawayhs.com", "theagencyre.com", "century21.com", "remax.com",
  "remaxrealty.com", "christiesrealestate.com", "halstead.com", "brownharrisstevens.com",
  "windermere.com", "longandfoster.com", "betterhomesandgardens.com",
  // Automated / transactional
  "notifications.google.com", "accounts.google.com", "mail.google.com",
  "docusign.net", "docusign.com", "echosign.com", "hellosign.com",
  "dropbox.com", "box.com", "zoom.us", "calendly.com",
  "noreply.github.com", "mailchimp.com", "constantcontact.com",
  "sendgrid.net", "amazonses.com", "mailgun.org",
]);

// Local-part patterns that indicate automated/no-reply senders
const NOREPLY_PATTERNS = [
  "noreply", "no-reply", "no_reply", "donotreply", "do-not-reply", "do_not_reply",
  "notifications", "notification", "newsletter", "mailer", "bounce", "bounces",
  "automated", "automailer", "auto-reply", "autoreply",
  "support", "helpdesk", "help", "info", "hello", "team", "admin",
  "billing", "invoices", "receipts", "updates", "alerts",
];

function shouldIgnoreForUnmatched(email: string): boolean {
  const [local, domain] = email.toLowerCase().split("@");
  if (!local || !domain) return true;
  if (BUILTIN_IGNORE_DOMAINS.has(domain)) return true;
  // Domain contains known brokerage/automated keywords
  if (/realt(y|or)|brokerage|mls|escrow|titleco|titlecompany/.test(domain)) return true;
  // Local part matches no-reply patterns
  if (NOREPLY_PATTERNS.some((p) => local === p || local.startsWith(p + "-") || local.startsWith(p + "_") || local.startsWith(p + "+"))) return true;
  return false;
}

function splitCsv(v: string | null | undefined): string[] {
  return (v || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

type GoogleTokenRow = {
  access_token: string | null;
  refresh_token: string | null;
  expiry_date: number | null;
};

type UserSettingsRow = {
  gmail_label_names: string | null;
  gmail_ignore_domains: string | null;
  gmail_ignore_emails: string | null;
  last_gmail_sync_at: string | null;
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

    const { data: tok, error: tokErr } = await supabaseAdmin
      .from("google_tokens")
      .select("access_token, refresh_token, expiry_date")
      .eq("user_id", uid)
      .single();

    if (tokErr || !tok)
      return NextResponse.json({ error: "Google not connected" }, { status: 400 });

    const tokenRow = tok as GoogleTokenRow;
    if (!tokenRow.refresh_token) {
      return NextResponse.json(
        { error: "Missing refresh token (reconnect Google)" },
        { status: 400 },
      );
    }

    const { data: settings, error: setErr } = await supabaseAdmin
      .from("user_settings")
      .select("gmail_label_names, gmail_ignore_domains, gmail_ignore_emails, last_gmail_sync_at")
      .eq("user_id", uid)
      .maybeSingle();

    if (setErr) return NextResponse.json({ error: setErr.message }, { status: 500 });

    const sRow = settings as UserSettingsRow | null;

    const labelNames = splitCsv(sRow?.gmail_label_names);
    if (labelNames.length === 0) {
      return NextResponse.json(
        { error: "No Gmail labels configured in settings." },
        { status: 400 },
      );
    }

    const ignoreDomains = new Set(splitCsv(sRow?.gmail_ignore_domains));
    const ignoreEmails = new Set(splitCsv(sRow?.gmail_ignore_emails));

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
      const name = (l.name || "").toLowerCase();
      const id = l.id || "";
      if (name && id) labelIdByName.set(name, id);
    });

    const labelIds = labelNames
      .map((n) => labelIdByName.get(n.toLowerCase()))
      .filter((x: string | undefined): x is string => typeof x === "string" && x.length > 0);

    if (labelIds.length === 0) {
      return NextResponse.json(
        {
          error: `None of the configured labels were found in Gmail. Configured: ${labelNames.join(", ")}`,
        },
        { status: 400 },
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

    let messagesFetched = 0;
    let messagesParsed = 0;
    let matchedRecipients = 0;

    let imported = 0;
    let skipped = 0;
    let unmatched = 0;

    let ignoredRecipients = 0;
    let ignoredByDomain = 0;
    let ignoredByEmail = 0;

    const unmatchedCounts = new Map<string, number>();
    const unmatchedMeta = new Map<string, { subject: string | null; snippet: string | null; threadLink: string | null }>();
    const uniqueRecipients = new Set<string>();

    // Incremental sync: only fetch messages newer than last sync
    const lastSyncAt = sRow?.last_gmail_sync_at ?? null;
    const afterDate = lastSyncAt
      ? new Date(lastSyncAt)
      : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000); // first sync: last 90 days
    const afterStr = `${afterDate.getFullYear()}/${afterDate.getMonth() + 1}/${afterDate.getDate()}`;

    let pageToken: string | undefined = undefined;
    const maxMessages = 500;
    const BATCH = 10; // parallel fetches per round

    while (messagesFetched < maxMessages) {
      const listRes: gmail_v1.Schema$ListMessagesResponse = (
        await gmail.users.messages.list({
          userId: "me",
          labelIds: ["SENT"],
          q: `after:${afterStr}`,
          maxResults: Math.min(100, maxMessages - messagesFetched),
          pageToken,
        })
      ).data;

      const msgs = listRes.messages ?? [];
      pageToken = listRes.nextPageToken ?? undefined;

      if (msgs.length === 0) break;
      messagesFetched += msgs.length;

      // Fetch metadata in parallel batches of BATCH
      for (let i = 0; i < msgs.length; i += BATCH) {
        const batch = msgs.slice(i, i + BATCH).filter((m) => !!m.id);
        const fulls = await Promise.all(
          batch.map((m) =>
            gmail.users.messages.get({
              userId: "me",
              id: m.id!,
              format: "metadata",
              metadataHeaders: ["To", "Cc", "Bcc", "Subject", "Date"],
            })
          )
        );

      for (const full of fulls) {

        const msgLabelIds = full.data.labelIds ?? [];
        const hasAnyConfiguredLabel = msgLabelIds.some((lid) => labelIds.includes(lid));

        messagesParsed += 1;

        const headers = full.data.payload?.headers ?? [];
        const toEmails = parseEmails(headerValue(headers, "To"));
        const ccEmails = parseEmails(headerValue(headers, "Cc"));
        const bccEmails = parseEmails(headerValue(headers, "Bcc"));
        const allRecipientsRaw = Array.from(new Set([...toEmails, ...ccEmails, ...bccEmails]));

        // Apply ignore rules
        const allRecipients = allRecipientsRaw.filter((e) => {
          if (!e) return false;
          const domain = e.split("@")[1]?.toLowerCase() || "";
          if (ignoreEmails.has(e)) {
            ignoredRecipients += 1;
            ignoredByEmail += 1;
            return false;
          }
          if (domain && ignoreDomains.has(domain)) {
            ignoredRecipients += 1;
            ignoredByDomain += 1;
            return false;
          }
          return true;
        });

        // Track unique recipients AFTER ignore filtering
        allRecipients.forEach((e) => uniqueRecipients.add(e));

        if (allRecipients.length === 0) {
          continue;
        }

        const subject = headerValue(headers, "Subject") || "";
        const internalDateMs = Number(full.data.internalDate || 0);
        const occurredAt = internalDateMs
          ? new Date(internalDateMs).toISOString()
          : new Date().toISOString();
        const snippet = (full.data.snippet || "").trim();

        const matchedEmail = allRecipients.find((e) => contactIdByEmail.has(e));
        if (!matchedEmail) {
          // Track unmatched for ALL sent messages, regardless of label
          unmatched += 1;
          const threadId = full.data.threadId || "";
          const threadLink = threadId ? `https://mail.google.com/mail/u/0/#all/${threadId}` : null;
          for (const e of allRecipients) {
            if (shouldIgnoreForUnmatched(e)) continue;
            unmatchedCounts.set(e, (unmatchedCounts.get(e) || 0) + 1);
            if (!unmatchedMeta.has(e)) {
              unmatchedMeta.set(e, { subject: subject || null, snippet: snippet || null, threadLink });
            }
          }
          continue;
        }

        // Only create touches for messages with the configured label
        if (!hasAnyConfiguredLabel) {
          continue;
        }

        matchedRecipients += 1;

        const contactId = contactIdByEmail.get(matchedEmail);
        if (!contactId) {
          unmatched += 1;
          continue;
        }

        const threadId = full.data.threadId || "";
        const link: string | null = threadId
          ? `https://mail.google.com/mail/u/0/#all/${threadId}`
          : null;

        const messageId = full.data.id ?? "";
        const summary = (snippet || subject).trim() || null;

        // Dedupe by messageId
        const { data: ex1, error: ex1Err } = await supabaseAdmin
          .from("touches")
          .select("id")
          .eq("contact_id", contactId)
          .eq("source", "gmail")
          .eq("source_message_id", messageId)
          .limit(1);

        if (ex1Err) {
          skipped += 1;
          continue;
        }
        if ((ex1 ?? []).length > 0) {
          skipped += 1;
          continue;
        }

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
          skipped += 1;
          continue;
        }

        imported += 1;
      } // end for (full of fulls)
      } // end batch loop

      if (!pageToken) break;
    }

    // Persist unmatched emails to unmatched_recipients table
    if (unmatchedCounts.size > 0) {
      const now = new Date().toISOString();
      const upsertRows = Array.from(unmatchedCounts.entries()).map(([email, count]) => {
        const meta = unmatchedMeta.get(email);
        return {
          email,
          first_seen_at: now,
          last_seen_at: now,
          seen_count: count,
          last_subject: meta?.subject ?? null,
          last_snippet: meta?.snippet ?? null,
          last_thread_link: meta?.threadLink ?? null,
          status: "new",
        };
      });

      // Upsert in batches of 50; on conflict update everything except first_seen_at
      for (let i = 0; i < upsertRows.length; i += 50) {
        const { error: upsertErr } = await supabaseAdmin
          .from("unmatched_recipients")
          .upsert(upsertRows.slice(i, i + 50), { onConflict: "email", ignoreDuplicates: false });
        if (upsertErr) console.error("UNMATCHED_UPSERT_ERROR", upsertErr.message, upsertErr);
      }
    }

    // Save sync timestamp for incremental sync next run
    await supabaseAdmin
      .from("user_settings")
      .upsert({ user_id: uid, last_gmail_sync_at: new Date().toISOString() }, { onConflict: "user_id" });

    const topUnmatchedRecipients = Array.from(unmatchedCounts.entries())
      .map(([email, count]) => ({ email, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);

    return NextResponse.json({
      imported,
      skipped,
      unmatched,
      messagesFetched,
      messagesParsed,
      matchedRecipients,
      uniqueRecipientsFound: uniqueRecipients.size,
      contactsWithEmail: contactIdByEmail.size,
      ignoredRecipients,
      ignoredByDomain,
      ignoredByEmail,
      topUnmatchedRecipients,
      usedLabelNames: labelNames,
      usedLabelIds: labelIds,
      appliedLabelIds: ["SENT"],
      maxMessages,
      note: "Ignores recipients based on user_settings (domains + emails).",
    });
  } catch (e) {
    const se = safeErr(e);
    console.error("GMAIL_SYNC_CRASH", se);
    return NextResponse.json(
      { error: "Gmail sync crashed", details: se, details_json: JSON.stringify(se) },
      { status: 500 },
    );
  }
}
