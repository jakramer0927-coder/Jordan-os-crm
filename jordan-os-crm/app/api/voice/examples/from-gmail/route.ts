import { NextResponse } from "next/server";
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";

export const runtime = "nodejs";

const ROUTE_VERSION = "voice-from-gmail@2026-03-01b";

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

function parseBool(v: string | null, defaultVal: boolean) {
  if (v == null) return defaultVal;
  const s = v.toLowerCase().trim();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return defaultVal;
}

function clampInt(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

type GoogleTokenRow = {
  access_token: string | null;
  refresh_token: string | null;
  expiry_date: number | null;
};

type UserSettingsRow = {
  gmail_label_names: string | null;
};

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const found = headers.find((h) => (h.name || "").toLowerCase() === name.toLowerCase());
  return found?.value || undefined;
}

function buildVoiceText(subject: string, snippet: string) {
  // Keep it simple: this is “seed” voice. Even short is useful.
  const s = (subject || "").trim();
  const sn = (snippet || "").trim();
  const combined = [s ? `Subject: ${s}` : "", sn ? `Snippet: ${sn}` : ""].filter(Boolean).join("\n");
  return combined.trim();
}

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);

    const uid = url.searchParams.get("uid") || "";
    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid", version: ROUTE_VERSION }, { status: 400 });

    const days = clampInt(Number(url.searchParams.get("days") || 365), 1, 3650);
    const maxMessages = clampInt(Number(url.searchParams.get("max") || 400), 1, 2000);

    // default false (do NOT require labels)
    const requireLabels = parseBool(url.searchParams.get("requireLabels"), false);

    // NEW: min length filter defaults to 0 (don’t drop anything)
    const minLen = clampInt(Number(url.searchParams.get("minLen") || 0), 0, 500);

    if (!process.env.SUPABASE_URL) return NextResponse.json({ error: "Missing SUPABASE_URL", version: ROUTE_VERSION }, { status: 500 });
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
      return NextResponse.json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY", version: ROUTE_VERSION }, { status: 500 });
    if (!process.env.GOOGLE_CLIENT_ID) return NextResponse.json({ error: "Missing GOOGLE_CLIENT_ID", version: ROUTE_VERSION }, { status: 500 });
    if (!process.env.GOOGLE_CLIENT_SECRET)
      return NextResponse.json({ error: "Missing GOOGLE_CLIENT_SECRET", version: ROUTE_VERSION }, { status: 500 });

    const { data: tok, error: tokErr } = await supabaseAdmin
      .from("google_tokens")
      .select("access_token, refresh_token, expiry_date")
      .eq("user_id", uid)
      .single();

    if (tokErr || !tok) return NextResponse.json({ error: "Google not connected", version: ROUTE_VERSION }, { status: 400 });

    const tokenRow = tok as GoogleTokenRow;
    if (!tokenRow.refresh_token) {
      return NextResponse.json({ error: "Missing refresh token (reconnect Google)", version: ROUTE_VERSION }, { status: 400 });
    }

    const { data: settings, error: setErr } = await supabaseAdmin
      .from("user_settings")
      .select("gmail_label_names")
      .eq("user_id", uid)
      .maybeSingle();

    if (setErr) return NextResponse.json({ error: setErr.message, version: ROUTE_VERSION }, { status: 500 });

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

    let usedLabelNames: string[] = [];
    let usedLabelIds: string[] = [];

    if (requireLabels) {
      if (labelNames.length === 0) {
        return NextResponse.json(
          { error: "requireLabels=true but no Gmail labels configured in settings.", version: ROUTE_VERSION },
          { status: 400 }
        );
      }

      const labelsRes = await gmail.users.labels.list({ userId: "me" });
      const labels = labelsRes.data.labels ?? [];
      const labelIdByName = new Map<string, string>();
      labels.forEach((l) => {
        const name = l.name || "";
        const id = l.id || "";
        if (name && id) labelIdByName.set(name, id);
      });

      usedLabelNames = labelNames.slice();
      usedLabelIds = labelNames
        .map((n) => labelIdByName.get(n))
        .filter((x: string | undefined): x is string => typeof x === "string" && x.length > 0);

      if (usedLabelIds.length === 0) {
        return NextResponse.json(
          {
            error: `requireLabels=true but none of the configured labels were found in Gmail. Configured: ${labelNames.join(", ")}`,
            version: ROUTE_VERSION,
          },
          { status: 400 }
        );
      }
    }

    const usedQuery = `in:sent from:me newer_than:${days}d`;

    let pageToken: string | undefined = undefined;
    let messagesFetched = 0;

    let scanned = 0;
    let inserted = 0;

    // NEW: diagnostics
    let skipped = 0;
    let skippedTooShort = 0;
    let skippedDuped = 0;
    let skippedInsertErr = 0;

    let firstInsertError: string | null = null;

    const samples: Array<{ id: string; subject: string; snippetLen: number; textLen: number }> = [];

    while (messagesFetched < maxMessages) {
      const batchSize = Math.min(100, maxMessages - messagesFetched);

      const listRes: gmail_v1.Schema$ListMessagesResponse =
        (
          await gmail.users.messages.list({
            userId: "me",
            q: usedQuery,
            labelIds: requireLabels ? ["SENT", ...usedLabelIds] : ["SENT"],
            maxResults: batchSize,
            pageToken,
          })
        ).data;

      const msgs = listRes.messages ?? [];
      pageToken = listRes.nextPageToken ?? undefined;

      if (msgs.length === 0) break;

      messagesFetched += msgs.length;

      for (const m of msgs) {
        if (!m.id) continue;
        scanned += 1;

        const full = await gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "metadata",
          metadataHeaders: ["Subject", "Date"],
        });

        const subject = headerValue(full.data.payload?.headers ?? [], "Subject") || "";
        const snippet = (full.data.snippet || "").trim();
        const text = buildVoiceText(subject, snippet);

        if (samples.length < 8) {
          samples.push({ id: m.id, subject, snippetLen: snippet.length, textLen: text.length });
        }

        if (text.length < minLen) {
          skipped += 1;
          skippedTooShort += 1;
          continue;
        }

        const internalDateMs = Number(full.data.internalDate || 0);
        const occurredAt = internalDateMs ? new Date(internalDateMs).toISOString() : new Date().toISOString();

        const { data: existing, error: exErr } = await supabaseAdmin
          .from("user_voice_examples")
          .select("id")
          .eq("user_id", uid)
          .eq("source", "gmail")
          .eq("source_message_id", m.id)
          .limit(1);

        if (!exErr && (existing ?? []).length > 0) {
          skipped += 1;
          skippedDuped += 1;
          continue;
        }

        const { error: insErr } = await supabaseAdmin.from("user_voice_examples").insert({
          user_id: uid,
          source: "gmail",
          source_message_id: m.id,
          occurred_at: occurredAt,
          text,
        });

        if (insErr) {
          skipped += 1;
          skippedInsertErr += 1;
          if (!firstInsertError) firstInsertError = insErr.message;
          continue;
        }

        inserted += 1;
      }

      if (!pageToken) break;
    }

    return NextResponse.json({
      ok: true,
      version: ROUTE_VERSION,
      requireLabels,
      usedLabelNames: requireLabels ? usedLabelNames : [],
      usedLabelIds: requireLabels ? usedLabelIds : [],
      usedQuery,
      days,
      maxMessages,
      minLen,
      scanned,
      messagesFetched,
      inserted,
      skipped,
      skipBreakdown: {
        tooShort: skippedTooShort,
        duped: skippedDuped,
        insertErr: skippedInsertErr,
      },
      firstInsertError,
      samples,
      note: "Default behavior does NOT require labels. Use minLen to filter if you want.",
    });
  } catch (e) {
    const se = safeErr(e);
    console.error("VOICE_FROM_GMAIL_CRASH", se);
    return NextResponse.json(
      {
        ok: false,
        version: ROUTE_VERSION,
        error: "Voice import crashed",
        details: se,
      },
      { status: 500 }
    );
  }
}