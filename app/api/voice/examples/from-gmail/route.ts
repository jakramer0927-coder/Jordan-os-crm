// app/api/voice/examples/from-gmail/route.ts
import { NextResponse } from "next/server";
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Ingest "voice examples" from Gmail SENT mail.
 * Stores short-ish text samples that we can use later to shape Jordan OS outbound drafts.
 *
 * Table: public.user_voice_examples
 * Required (per your schema + constraints): user_id, channel (NOT NULL), occurred_at, text (assumed NOT NULL)
 */

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function safeErr(e: unknown) {
  const anyE = e as { message?: unknown; name?: unknown; stack?: unknown };
  return {
    message: String(anyE?.message || e || "Unknown error"),
    name: String(anyE?.name || ""),
    stack: typeof anyE?.stack === "string" ? anyE.stack.split("\n").slice(0, 14).join("\n") : "",
  };
}

function parseIntOr(v: string | null, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function parseBool(v: string | null, fallback: boolean) {
  if (v == null) return fallback;
  const s = v.toLowerCase().trim();
  if (s === "1" || s === "true" || s === "yes" || s === "y") return true;
  if (s === "0" || s === "false" || s === "no" || s === "n") return false;
  return fallback;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function headerValue(
  headers: gmail_v1.Schema$MessagePartHeader[] | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const found = headers.find((h) => (h.name || "").toLowerCase() === name.toLowerCase());
  return found?.value || undefined;
}

function cleanText(s: string) {
  return (s || "")
    .replace(/\s+/g, " ")
    .replace(/\u0000/g, "")
    .trim();
}

type GoogleTokenRow = {
  access_token: string | null;
  refresh_token: string | null;
  expiry_date: number | null;
};

type UserSettingsRow = {
  gmail_label_names: string | null;
};

type VoiceExampleInsert = {
  user_id: string;
  channel: "email";
  intent: string | null;
  contact_category: string | null;
  text: string;
  source: "gmail";
  source_message_id: string;
  source_link: string | null;
  created_at?: string;
  occurred_at: string;
  subject: string | null;
  snippet: string | null;
  body_preview: string | null;
};

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const url = new URL(req.url);

    // Options
    const days = clamp(parseIntOr(url.searchParams.get("days"), 365), 1, 3650);
    const maxMessages = clamp(parseIntOr(url.searchParams.get("max"), 100), 1, 500);
    const requireLabels = parseBool(url.searchParams.get("requireLabels"), false);
    const minLen = clamp(parseIntOr(url.searchParams.get("minLen"), 140), 0, 2000);

    // Sanity env checks (common 500 causes)
    if (!process.env.SUPABASE_URL)
      return NextResponse.json({ ok: false, error: "Missing SUPABASE_URL" }, { status: 500 });
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
      return NextResponse.json(
        { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" },
        { status: 500 },
      );
    if (!process.env.GOOGLE_CLIENT_ID)
      return NextResponse.json({ ok: false, error: "Missing GOOGLE_CLIENT_ID" }, { status: 500 });
    if (!process.env.GOOGLE_CLIENT_SECRET)
      return NextResponse.json(
        { ok: false, error: "Missing GOOGLE_CLIENT_SECRET" },
        { status: 500 },
      );

    // Load tokens
    const { data: tok, error: tokErr } = await supabaseAdmin
      .from("google_tokens")
      .select("access_token, refresh_token, expiry_date")
      .eq("user_id", uid)
      .single();

    if (tokErr || !tok)
      return NextResponse.json({ ok: false, error: "Google not connected" }, { status: 400 });

    const tokenRow = tok as GoogleTokenRow;
    if (!tokenRow.refresh_token) {
      return NextResponse.json(
        { ok: false, error: "Missing refresh token (reconnect Google)" },
        { status: 400 },
      );
    }

    // Load settings for optional label restriction
    const { data: settings, error: setErr } = await supabaseAdmin
      .from("user_settings")
      .select("gmail_label_names")
      .eq("user_id", uid)
      .maybeSingle();

    if (setErr) return NextResponse.json({ ok: false, error: setErr.message }, { status: 500 });

    const sRow = settings as UserSettingsRow | null;

    const labelNames = (sRow?.gmail_label_names || "")
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    const oauth2 = getGoogleOAuthClient();
    oauth2.setCredentials({
      access_token: tokenRow.access_token ?? undefined,
      refresh_token: tokenRow.refresh_token ?? undefined,
      expiry_date: tokenRow.expiry_date ?? undefined,
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    // Label IDs (only if requireLabels=true)
    let usedLabelNames: string[] = [];
    let usedLabelIds: string[] = [];

    if (requireLabels) {
      if (labelNames.length === 0) {
        return NextResponse.json(
          { ok: false, error: "requireLabels=true but no Gmail labels configured in settings." },
          { status: 400 },
        );
      }

      const labelsRes = await gmail.users.labels.list({ userId: "me" });
      const labels = labelsRes.data.labels ?? [];

      const labelIdByName = new Map<string, string>();
      labels.forEach((l: gmail_v1.Schema$Label) => {
        const name = l.name || "";
        const id = l.id || "";
        if (name && id) labelIdByName.set(name, id);
      });

      usedLabelNames = labelNames;
      usedLabelIds = labelNames
        .map((n) => labelIdByName.get(n))
        .filter((x: string | undefined): x is string => typeof x === "string" && x.length > 0);

      if (usedLabelIds.length === 0) {
        return NextResponse.json(
          {
            ok: false,
            error: `None of the configured labels were found in Gmail. Configured: ${labelNames.join(", ")}`,
          },
          { status: 400 },
        );
      }
    }

    // Query (SENT + from:me + newer_than)
    // NOTE: Gmail "newer_than" uses d/m/y suffixes; we use days.
    const q = `in:sent from:me newer_than:${days}d`;

    let pageToken: string | undefined = undefined;
    let scanned = 0;
    let messagesFetched = 0;

    let inserted = 0;
    let skipped = 0;

    const skipBreakdown: Record<string, number> = { tooShort: 0, duped: 0, insertErr: 0 };
    let firstInsertError: string | null = null;

    // We'll return a few samples for debugging
    const samples: Array<{ id: string; subject: string; snippetLen: number; textLen: number }> = [];

    while (scanned < maxMessages) {
      const res = await gmail.users.messages.list({
        userId: "me",
        q,
        labelIds: requireLabels ? usedLabelIds : undefined,
        maxResults: Math.min(100, maxMessages - scanned),
        pageToken,
      });

      const listRes: gmail_v1.Schema$ListMessagesResponse = res.data;
      pageToken = listRes.nextPageToken ?? undefined;

      const msgs = listRes.messages ?? [];
      if (msgs.length === 0) break;

      messagesFetched += msgs.length;

      for (const m of msgs) {
        if (!m.id) continue;
        scanned += 1;

        // Fetch minimal metadata
        const full = await gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "metadata",
          metadataHeaders: ["Subject", "Date"],
        });

        const headers = full.data.payload?.headers ?? [];
        const subject = cleanText(headerValue(headers, "Subject") || "");
        const snippet = cleanText(full.data.snippet || "");

        const internalDateMs = Number(full.data.internalDate || 0);
        const occurredAt = internalDateMs
          ? new Date(internalDateMs).toISOString()
          : new Date().toISOString();

        // Build text sample (keep it simple for now)
        // We want something that's clearly "your voice": snippet + subject is usually enough
        const combined = cleanText(`${subject ? `Subject: ${subject}\n` : ""}${snippet}`);

        if (combined.length < minLen) {
          skipped += 1;
          skipBreakdown.tooShort += 1;
          continue;
        }

        // Dedupe: (user_id, source, source_message_id)
        const { data: existing, error: exErr } = await supabaseAdmin
          .from("user_voice_examples")
          .select("id")
          .eq("user_id", uid)
          .eq("source", "gmail")
          .eq("source_message_id", m.id)
          .limit(1);

        if (!exErr && (existing ?? []).length > 0) {
          skipped += 1;
          skipBreakdown.duped += 1;
          continue;
        }

        const threadId = full.data.threadId || "";
        const link = threadId ? `https://mail.google.com/mail/u/0/#all/${threadId}` : null;

        // Insert row (IMPORTANT: channel is NOT NULL)
        const row: VoiceExampleInsert = {
          user_id: uid,
          channel: "email",
          intent: null,
          contact_category: null,
          text: combined,
          source: "gmail",
          source_message_id: m.id,
          source_link: link,
          occurred_at: occurredAt,
          subject: subject || null,
          snippet: snippet || null,
          body_preview: snippet || null,
        };

        const { error: insErr } = await supabaseAdmin.from("user_voice_examples").insert(row);

        if (insErr) {
          skipped += 1;
          skipBreakdown.insertErr += 1;
          if (!firstInsertError) firstInsertError = insErr.message;
          continue;
        }

        inserted += 1;

        if (samples.length < 8) {
          samples.push({
            id: m.id,
            subject: subject || "(no subject)",
            snippetLen: snippet.length,
            textLen: combined.length,
          });
        }

        if (scanned >= maxMessages) break;
      }

      if (!pageToken) break;
    }

    return NextResponse.json({
      ok: true,
      version: "voice-from-gmail@2026-03-01c",
      requireLabels,
      usedLabelNames: requireLabels ? usedLabelNames : [],
      usedLabelIds: requireLabels ? usedLabelIds : [],
      usedQuery: q,
      days,
      maxMessages,
      minLen,
      scanned,
      messagesFetched,
      inserted,
      skipped,
      skipBreakdown,
      firstInsertError,
      samples,
      note: "Stores subject+snippet as initial voice examples. Channel is always 'email' to satisfy NOT NULL.",
    });
  } catch (e) {
    const se = safeErr(e);
    console.error("VOICE_FROM_GMAIL_CRASH", se);
    return NextResponse.json(
      {
        ok: false,
        error: "Voice examples import crashed",
        details: se,
        details_message: se.message,
      },
      { status: 500 },
    );
  }
}
