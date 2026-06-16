import { NextResponse } from "next/server";
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { loadVoiceMailboxes } from "@/lib/googleMailboxes";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}


function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const found = headers.find((h) => (h.name || "").toLowerCase() === name.toLowerCase());
  return found?.value || undefined;
}

function b64urlToUtf8(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const buf = Buffer.from(b64 + pad, "base64");
  return buf.toString("utf8");
}

function extractTextFromPayload(payload?: gmail_v1.Schema$MessagePart): string {
  if (!payload) return "";
  const parts: gmail_v1.Schema$MessagePart[] = [];

  const walk = (p: gmail_v1.Schema$MessagePart) => {
    parts.push(p);
    (p.parts || []).forEach(walk);
  };
  walk(payload);

  const plain = parts.find(
    (p) => (p.mimeType || "").toLowerCase() === "text/plain" && p.body?.data,
  );
  if (plain?.body?.data) return stripQuotedText(b64urlToUtf8(plain.body.data));

  const html = parts.find((p) => (p.mimeType || "").toLowerCase() === "text/html" && p.body?.data);
  if (html?.body?.data) {
    const raw = b64urlToUtf8(html.body.data);
    const stripped = raw
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "") // strip quoted blocks
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return stripQuotedText(stripped);
  }

  return "";
}

// Remove quoted/forwarded text so only Jordan's original words are captured
function stripQuotedText(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Common markers for where quoted content begins
    if (trimmed.startsWith(">")) break;
    if (/^On .{10,} wrote:$/i.test(trimmed)) break;
    if (/^-{4,}\s*(Original|Forwarded)\s+Message/i.test(trimmed)) break;
    if (/^From:\s+\S+@\S+/.test(trimmed) && result.length > 4) break;
    if (/^Sent:\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(trimmed) && result.length > 4) break;
    result.push(line);
  }

  return result.join("\n").trim();
}

type GoogleTokenRow = {
  access_token: string | null;
  refresh_token: string | null;
  expiry_date: number | null;
};

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}) as any);
    const days = typeof body?.days === "number" ? Math.max(7, Math.min(3650, body.days)) : 365;
    const maxMessages =
      typeof body?.maxMessages === "number" ? Math.max(50, Math.min(2000, body.maxMessages)) : 600;

    // Every mailbox we harvest voice from: the primary connection + any extra
    // mailboxes the user added (e.g. a second brokerage identity).
    const mailboxes = await loadVoiceMailboxes(uid);
    if (mailboxes.length === 0)
      return NextResponse.json({ error: "Google not connected" }, { status: 400 });

    // Load all already-synced message IDs upfront to avoid per-message DB calls
    const { data: existingRows } = await supabaseAdmin
      .from("user_voice_examples")
      .select("source_message_id")
      .eq("user_id", uid)
      .not("source_message_id", "is", null)
      .limit(20000);
    const existingIds = new Set((existingRows ?? []).map((r: any) => r.source_message_id as string));

    // Search ALL sent emails — no label filter. Voice training needs the full picture.
    const q = `in:sent from:me newer_than:${days}d`;

    let scanned = 0;
    let inserted = 0;
    let skipped = 0;
    let skippedAlreadySynced = 0;
    let skippedTooShort = 0;
    let skippedError = 0;
    const perMailbox: Array<{ email: string | null; source: string; scanned: number; inserted: number; error?: string }> = [];

    for (const mb of mailboxes) {
      const gmail = google.gmail({ version: "v1", auth: mb.oauth2 });
      let mbScanned = 0;
      let mbInserted = 0;
      let pageToken: string | undefined = undefined;

      try {
        while (mbScanned < maxMessages) {
          const listCall = await gmail.users.messages.list({
            userId: "me",
            q,
            maxResults: Math.min(100, maxMessages - mbScanned),
            pageToken,
          });

          const listData: gmail_v1.Schema$ListMessagesResponse = listCall.data;
          const msgs = listData.messages ?? [];
          pageToken = listData.nextPageToken ?? undefined;
          if (msgs.length === 0) break;

          for (const m of msgs) {
            if (!m.id) continue;
            scanned += 1;
            mbScanned += 1;

            // Same Gmail message id across mailboxes (forwards) — skip the duplicate
            if (existingIds.has(m.id)) { skipped += 1; skippedAlreadySynced += 1; continue; }

            const fullCall = await gmail.users.messages.get({ userId: "me", id: m.id, format: "full" });
            const fullData: gmail_v1.Schema$Message = fullCall.data;

            const headers = fullData.payload?.headers ?? [];
            const subject = headerValue(headers, "Subject") || "";
            const snippet = (fullData.snippet || "").trim();
            const bodyText = extractTextFromPayload(fullData.payload);

            const raw = (bodyText || snippet || subject).trim();
            const text = raw.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 4000);

            if (!text || text.length < 40) { skipped += 1; skippedTooShort += 1; continue; }

            const threadId = fullData.threadId || "";
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

            if (insErr) { skipped += 1; skippedError += 1; }
            else { inserted += 1; mbInserted += 1; existingIds.add(m.id); }
          }

          if (!pageToken) break;
        }
        perMailbox.push({ email: mb.email, source: mb.source, scanned: mbScanned, inserted: mbInserted });
      } catch (mbErr: any) {
        // One mailbox failing (e.g. revoked token) shouldn't abort the others
        perMailbox.push({ email: mb.email, source: mb.source, scanned: mbScanned, inserted: mbInserted, error: mbErr?.message ?? "mailbox sync failed" });
      }
    }

    return NextResponse.json({
      ok: true,
      scanned,
      inserted,
      skipped,
      skippedAlreadySynced,
      skippedTooShort,
      skippedError,
      mailboxes: perMailbox,
      days,
      maxMessages,
      usedQuery: q,
      note: "Inserted email voice examples from all connected Gmail mailboxes.",
    });
  } catch (e) {
    return serverError("VOICE_SYNC_GMAIL_CRASH", e);
  }
}
