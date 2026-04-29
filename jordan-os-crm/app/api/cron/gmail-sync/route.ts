import { NextResponse } from "next/server";
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";
import { decryptToken } from "@/lib/tokenCrypto";

export const runtime = "nodejs";

// ── helpers shared with gmail/sync ──────────────────────────────────────────

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

const BUILTIN_IGNORE_DOMAINS = new Set([
  "compass.com", "elliman.com", "douglaselliman.com", "sothebysrealty.com",
  "corcoran.com", "kwrealty.com", "kw.com", "coldwellbanker.com", "bhhs.com",
  "berkshirehathawayhs.com", "theagencyre.com", "century21.com", "remax.com",
  "remaxrealty.com", "christiesrealestate.com", "halstead.com", "brownharrisstevens.com",
  "windermere.com", "longandfoster.com", "betterhomesandgardens.com",
  "notifications.google.com", "accounts.google.com", "mail.google.com",
  "docusign.net", "docusign.com", "echosign.com", "hellosign.com",
  "dropbox.com", "box.com", "zoom.us", "calendly.com",
  "noreply.github.com", "mailchimp.com", "constantcontact.com",
  "sendgrid.net", "amazonses.com", "mailgun.org",
]);

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
  if (/realt(y|or)|brokerage|mls|escrow|titleco|titlecompany/.test(domain)) return true;
  if (NOREPLY_PATTERNS.some((p) =>
    local === p || local.startsWith(p + "-") || local.startsWith(p + "_") || local.startsWith(p + "+")
  )) return true;
  return false;
}

function splitCsv(v: string | null | undefined): string[] {
  return (v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// ── voice example helpers ────────────────────────────────────────────────────

function b64urlToUtf8(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  return Buffer.from(b64 + pad, "base64").toString("utf8");
}

function stripQuotedText(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(">")) break;
    if (/^On .{10,} wrote:$/i.test(trimmed)) break;
    if (/^-{4,}\s*(Original|Forwarded)\s+Message/i.test(trimmed)) break;
    if (/^From:\s+\S+@\S+/.test(trimmed) && result.length > 4) break;
    result.push(line);
  }
  return result.join("\n").trim();
}

function extractTextFromPayload(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return "";
  const parts: gmail_v1.Schema$MessagePart[] = [];
  const walk = (p: gmail_v1.Schema$MessagePart) => { parts.push(p); (p.parts || []).forEach(walk); };
  walk(payload);

  const plain = parts.find((p) => (p.mimeType || "").toLowerCase() === "text/plain" && p.body?.data);
  if (plain?.body?.data) return stripQuotedText(b64urlToUtf8(plain.body.data));

  const html = parts.find((p) => (p.mimeType || "").toLowerCase() === "text/html" && p.body?.data);
  if (html?.body?.data) {
    const raw = b64urlToUtf8(html.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripQuotedText(raw);
  }
  return "";
}

// ── per-user sync ────────────────────────────────────────────────────────────

async function syncUser(uid: string, tok: any): Promise<{
  touches: { imported: number; skipped: number };
  unmatched: { inserted: number; updated: number };
  voice: { inserted: number; skipped: number };
  error?: string;
}> {
  const result = {
    touches: { imported: 0, skipped: 0 },
    unmatched: { inserted: 0, updated: 0 },
    voice: { inserted: 0, skipped: 0 },
  };

  try {
    const oauth2 = getGoogleOAuthClient();
    oauth2.setCredentials({
      access_token: tok.access_token ? decryptToken(tok.access_token) : undefined,
      refresh_token: tok.refresh_token ? decryptToken(tok.refresh_token) : undefined,
      expiry_date: tok.expiry_date ?? undefined,
    });
    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    // ── Load user settings ────────────────────────────────────────────────
    const { data: settings } = await supabaseAdmin
      .from("user_settings")
      .select("gmail_label_names, gmail_ignore_domains, gmail_ignore_emails, last_gmail_sync_at")
      .eq("user_id", uid)
      .maybeSingle();

    const labelNames = splitCsv(settings?.gmail_label_names);
    const ignoreDomains = new Set(splitCsv(settings?.gmail_ignore_domains));
    const ignoreEmails = new Set(splitCsv(settings?.gmail_ignore_emails));
    const lastSyncAt = settings?.last_gmail_sync_at ?? null;

    // ── Resolve label IDs (required for touch creation) ──────────────────
    let labelIds: string[] = [];
    if (labelNames.length > 0) {
      const labelsRes = await gmail.users.labels.list({ userId: "me" });
      const labelIdByName = new Map<string, string>();
      (labelsRes.data.labels ?? []).forEach((l: gmail_v1.Schema$Label) => {
        if (l.name && l.id) labelIdByName.set(l.name.toLowerCase(), l.id);
      });
      labelIds = labelNames
        .map((n) => labelIdByName.get(n.toLowerCase()))
        .filter((x): x is string => typeof x === "string");
    }

    // ── Load user's contact emails (scoped to this user) ─────────────────
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

    // ── Incremental date range ────────────────────────────────────────────
    const afterDate = lastSyncAt
      ? new Date(lastSyncAt)
      : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const afterStr = `${afterDate.getFullYear()}/${afterDate.getMonth() + 1}/${afterDate.getDate()}`;

    // ── Fetch sent messages ───────────────────────────────────────────────
    const unmatchedCounts = new Map<string, number>();
    const unmatchedMeta = new Map<string, { subject: string | null; snippet: string | null; threadLink: string | null }>();

    let pageToken: string | undefined;
    let fetched = 0;
    const MAX = 500;
    const BATCH = 10;

    while (fetched < MAX) {
      const listRes: gmail_v1.Schema$ListMessagesResponse = (
        await gmail.users.messages.list({
          userId: "me",
          labelIds: ["SENT"],
          q: `after:${afterStr}`,
          maxResults: Math.min(100, MAX - fetched),
          pageToken,
        })
      ).data;

      const msgs = listRes.messages ?? [];
      pageToken = listRes.nextPageToken ?? undefined;
      if (msgs.length === 0) break;
      fetched += msgs.length;

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
          const hasConfiguredLabel = labelIds.length === 0 || msgLabelIds.some((lid) => labelIds.includes(lid));

          const headers = full.data.payload?.headers ?? [];
          const allRecipientsRaw = Array.from(new Set([
            ...parseEmails(headerValue(headers, "To")),
            ...parseEmails(headerValue(headers, "Cc")),
            ...parseEmails(headerValue(headers, "Bcc")),
          ]));

          const allRecipients = allRecipientsRaw.filter((e) => {
            const domain = e.split("@")[1]?.toLowerCase() || "";
            if (ignoreEmails.has(e)) return false;
            if (domain && ignoreDomains.has(domain)) return false;
            return true;
          });

          if (allRecipients.length === 0) continue;

          const subject = headerValue(headers, "Subject") || "";
          const internalDateMs = Number(full.data.internalDate || 0);
          const occurredAt = internalDateMs ? new Date(internalDateMs).toISOString() : new Date().toISOString();
          const snippet = (full.data.snippet || "").trim();
          const threadId = full.data.threadId || "";
          const threadLink = threadId ? `https://mail.google.com/mail/u/0/#all/${threadId}` : null;
          const messageId = full.data.id ?? "";

          const matchedEmail = allRecipients.find((e) => contactIdByEmail.has(e));

          if (!matchedEmail) {
            // Track for unmatched
            for (const e of allRecipients) {
              if (shouldIgnoreForUnmatched(e)) continue;
              unmatchedCounts.set(e, (unmatchedCounts.get(e) || 0) + 1);
              if (!unmatchedMeta.has(e)) {
                unmatchedMeta.set(e, { subject: subject || null, snippet: snippet || null, threadLink });
              }
            }
            continue;
          }

          // Only create touches for labeled messages (or no label configured)
          if (!hasConfiguredLabel) continue;

          const contactId = contactIdByEmail.get(matchedEmail);
          if (!contactId) continue;

          // Dedupe by messageId
          const { data: existing } = await supabaseAdmin
            .from("touches")
            .select("id")
            .eq("contact_id", contactId)
            .eq("source", "gmail")
            .eq("source_message_id", messageId)
            .limit(1);

          if ((existing ?? []).length > 0) { result.touches.skipped++; continue; }

          const { error: insErr } = await supabaseAdmin.from("touches").insert({
            contact_id: contactId,
            channel: "email",
            direction: "outbound",
            occurred_at: occurredAt,
            intent: "check_in",
            summary: (snippet || subject).trim() || null,
            source: "gmail",
            source_link: threadLink,
            source_message_id: messageId,
          });

          if (insErr) result.touches.skipped++;
          else result.touches.imported++;
        }
      }

      if (!pageToken) break;
    }

    // ── Persist unmatched ─────────────────────────────────────────────────
    if (unmatchedCounts.size > 0) {
      const now = new Date().toISOString();
      const allEmails = Array.from(unmatchedCounts.keys());

      const { data: existing } = await supabaseAdmin
        .from("unmatched_recipients")
        .select("id, email")
        .eq("user_id", uid)
        .in("email", allEmails);

      const existingSet = new Set((existing ?? []).map((r: any) => r.email as string));

      const toInsert = allEmails.filter((e) => !existingSet.has(e)).map((email) => {
        const meta = unmatchedMeta.get(email);
        return {
          user_id: uid,
          email,
          first_seen_at: now,
          last_seen_at: now,
          seen_count: unmatchedCounts.get(email) ?? 1,
          last_subject: meta?.subject ?? null,
          last_snippet: meta?.snippet ?? null,
          last_thread_link: meta?.threadLink ?? null,
          status: "new",
        };
      });

      if (toInsert.length > 0) {
        for (let i = 0; i < toInsert.length; i += 50) {
          await supabaseAdmin.from("unmatched_recipients").upsert(toInsert.slice(i, i + 50), { onConflict: "email", ignoreDuplicates: true });
        }
        result.unmatched.inserted += toInsert.length;
      }

      for (const email of allEmails.filter((e) => existingSet.has(e))) {
        const meta = unmatchedMeta.get(email);
        await supabaseAdmin
          .from("unmatched_recipients")
          .update({
            last_seen_at: now,
            seen_count: unmatchedCounts.get(email) ?? 1,
            last_subject: meta?.subject ?? null,
            last_snippet: meta?.snippet ?? null,
            last_thread_link: meta?.threadLink ?? null,
          })
          .eq("user_id", uid)
          .eq("email", email);
        result.unmatched.updated++;
      }
    }

    // ── Update sync cursor ────────────────────────────────────────────────
    await supabaseAdmin
      .from("user_settings")
      .upsert({ user_id: uid, last_gmail_sync_at: new Date().toISOString() }, { onConflict: "user_id" });

    // ── Voice examples sync (last 30 days, max 200 messages) ─────────────
    const { data: existingVoice } = await supabaseAdmin
      .from("user_voice_examples")
      .select("source_message_id")
      .eq("user_id", uid)
      .not("source_message_id", "is", null)
      .limit(5000);

    const existingVoiceIds = new Set((existingVoice ?? []).map((r: any) => r.source_message_id as string));

    let vPageToken: string | undefined;
    let vScanned = 0;
    const V_MAX = 200;

    while (vScanned < V_MAX) {
      const vList = await gmail.users.messages.list({
        userId: "me",
        q: "in:sent from:me newer_than:30d",
        maxResults: Math.min(100, V_MAX - vScanned),
        pageToken: vPageToken,
      });

      const vMsgs = vList.data.messages ?? [];
      vPageToken = vList.data.nextPageToken ?? undefined;
      if (vMsgs.length === 0) break;

      for (const m of vMsgs) {
        if (!m.id) continue;
        vScanned++;

        if (existingVoiceIds.has(m.id)) { result.voice.skipped++; continue; }

        const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
        const headers = full.data.payload?.headers ?? [];
        const subject = headerValue(headers, "Subject") || "";
        const snippet = (full.data.snippet || "").trim();
        const bodyText = extractTextFromPayload(full.data.payload);

        const raw = (bodyText || snippet || subject).trim();
        const text = raw.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);
        if (!text || text.length < 40) { result.voice.skipped++; continue; }

        const threadId = full.data.threadId || "";
        const link = threadId ? `https://mail.google.com/mail/u/0/#all/${threadId}` : null;

        const { error: insErr } = await supabaseAdmin.from("user_voice_examples").insert({
          user_id: uid,
          channel: "email",
          intent: null,
          contact_category: null,
          text,
          source: "gmail",
          source_message_id: m.id,
          source_link: link,
        });

        if (insErr) result.voice.skipped++;
        else { result.voice.inserted++; existingVoiceIds.add(m.id); }
      }

      if (!vPageToken) break;
    }

    return result;
  } catch (e: any) {
    return { ...result, error: String(e?.message || e) };
  }
}

// ── cron handler ─────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { data: tokens } = await supabaseAdmin
      .from("google_tokens")
      .select("user_id, access_token, refresh_token, expiry_date");

    if (!tokens || tokens.length === 0) {
      return NextResponse.json({ ok: true, note: "No users with Google connected" });
    }

    const results = [];
    for (const tok of tokens as any[]) {
      if (!tok.refresh_token) {
        results.push({ uid: tok.user_id, skipped: "no refresh token" });
        continue;
      }
      const r = await syncUser(tok.user_id, tok);
      results.push({ uid: tok.user_id, ...r });
    }

    return NextResponse.json({ ok: true, ran_at: new Date().toISOString(), results });
  } catch (e: any) {
    console.error("CRON_GMAIL_SYNC_CRASH", e);
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
