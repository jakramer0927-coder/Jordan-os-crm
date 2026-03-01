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

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | undefined {
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

  const plain = parts.find((p) => (p.mimeType || "").toLowerCase() === "text/plain" && p.body?.data);
  if (plain?.body?.data) return b64urlToUtf8(plain.body.data);

  const html = parts.find((p) => (p.mimeType || "").toLowerCase() === "text/html" && p.body?.data);
  if (html?.body?.data) {
    const raw = b64urlToUtf8(html.body.data);
    return raw
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return "";
}

type GoogleTokenRow = {
  access_token: string | null;
  refresh_token: string | null;
  expiry_date: number | null;
};

type UserSettingsRow = {
  gmail_label_names: string | null;
};

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const uid = url.searchParams.get("uid") || "";
    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });

    const body = await req.json().catch(() => ({} as any));
    const days = typeof body?.days === "number" ? Math.max(7, Math.min(3650, body.days)) : 365;
    const maxMessages = typeof body?.maxMessages === "number" ? Math.max(50, Math.min(2000, body.maxMessages)) : 600;

    const { data: tok, error: tokErr } = await supabaseAdmin
      .from("google_tokens")
      .select("access_token, refresh_token, expiry_date")
      .eq("user_id", uid)
      .single();

    if (tokErr || !tok) return NextResponse.json({ error: "Google not connected" }, { status: 400 });

    const tokenRow = tok as GoogleTokenRow;
    if (!tokenRow.refresh_token) return NextResponse.json({ error: "Missing refresh token (reconnect Google)" }, { status: 400 });

    const { data: settings, error: setErr } = await supabaseAdmin
      .from("user_settings")
      .select("gmail_label_names")
      .eq("user_id", uid)
      .maybeSingle();

    if (setErr) return NextResponse.json({ error: setErr.message }, { status: 500 });

    const sRow = settings as UserSettingsRow | null;
    const labelNames = (sRow?.gmail_label_names || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const oauth2 = getGoogleOAuthClient();
    oauth2.setCredentials({
      access_token: tokenRow.access_token ?? undefined,
      refresh_token: tokenRow.refresh_token ?? undefined,
      expiry_date: tokenRow.expiry_date ?? undefined,
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    // Optional label filtering (if configured)
    let labelIds: string[] = [];
    if (labelNames.length > 0) {
      const labelsRes = await gmail.users.labels.list({ userId: "me" });
      const labels = labelsRes.data.labels ?? [];
      const labelIdByName = new Map<string, string>();
      labels.forEach((l: gmail_v1.Schema$Label) => {
        if (l.name && l.id) labelIdByName.set(l.name, l.id);
      });

      labelIds = labelNames
        .map((n) => labelIdByName.get(n))
        .filter((x: string | undefined): x is string => typeof x === "string" && x.length > 0);
    }

    const q = `in:sent from:me newer_than:${days}d`;

    let scanned = 0;
    let inserted = 0;
    let skipped = 0;
    let pageToken: string | undefined = undefined;

    while (scanned < maxMessages) {
      // ✅ Key fix: type the awaited response, then take `.data` into a typed variable.
      const listCall = await gmail.users.messages.list({
        userId: "me",
        q,
        maxResults: Math.min(100, maxMessages - scanned),
        pageToken,
        ...(labelIds.length > 0 ? { labelIds } : {}),
      });

      const listData: gmail_v1.Schema$ListMessagesResponse = listCall.data;

      const msgs = listData.messages ?? [];
      pageToken = listData.nextPageToken ?? undefined;
      if (msgs.length === 0) break;

      for (const m of msgs) {
        if (!m.id) continue;
        scanned += 1;

        const fullCall = await gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "full",
        });

        const fullData: gmail_v1.Schema$Message = fullCall.data;

        const headers = fullData.payload?.headers ?? [];
        const subject = headerValue(headers, "Subject") || "";
        const snippet = (fullData.snippet || "").trim();
        const bodyText = extractTextFromPayload(fullData.payload);

        const raw = (bodyText || snippet || subject).trim();
        const text = raw
          .replace(/\r/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim()
          .slice(0, 4000);

        if (!text) {
          skipped += 1;
          continue;
        }

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

        if (insErr) skipped += 1;
        else inserted += 1;
      }

      if (!pageToken) break;
    }

    return NextResponse.json({
      ok: true,
      scanned,
      inserted,
      skipped,
      days,
      maxMessages,
      usedQuery: q,
      usedLabelNames: labelNames,
      usedLabelIds: labelIds,
      note: "Inserted email voice examples from Gmail Sent.",
    });
  } catch (e) {
    const se = safeErr(e);
    console.error("VOICE_SYNC_GMAIL_CRASH", se);
    return NextResponse.json({ error: "Voice sync crashed", details: se }, { status: 500 });
  }
}