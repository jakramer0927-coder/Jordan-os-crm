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

// Very light heuristic so examples are “usable”
// (We’re learning voice, not perfect classification.)
function classifyContactCategoryFromEmail(email: string): string | null {
  const d = (email.split("@")[1] || "").toLowerCase();
  if (!d) return null;

  const agentDomains = ["compass.com", "theagencyre.com", "cbrealty.com", "sothebysrealty.com"];
  if (agentDomains.some((x) => d.includes(x))) return "agent";

  const consumer = new Set([
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "hotmail.com",
    "outlook.com",
    "live.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
  ]);
  if (consumer.has(d)) return "client";

  // fallback: unknown / could be vendor, agent, etc.
  return null;
}

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const uid = url.searchParams.get("uid") || "";
    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });

    // params
    const days = Number(url.searchParams.get("days") || "365");
    const maxMessages = Number(url.searchParams.get("max") || "500");
    const query = url.searchParams.get("q") || `in:sent from:me newer_than:${days}d`;

    if (!process.env.SUPABASE_URL) return NextResponse.json({ error: "Missing SUPABASE_URL" }, { status: 500 });
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY)
      return NextResponse.json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY" }, { status: 500 });
    if (!process.env.GOOGLE_CLIENT_ID) return NextResponse.json({ error: "Missing GOOGLE_CLIENT_ID" }, { status: 500 });
    if (!process.env.GOOGLE_CLIENT_SECRET)
      return NextResponse.json({ error: "Missing GOOGLE_CLIENT_SECRET" }, { status: 500 });

    // Load tokens
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

    // settings (labels optional)
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

    const oauth2 = getGoogleOAuthClient();
    oauth2.setCredentials({
      access_token: tokenRow.access_token ?? undefined,
      refresh_token: tokenRow.refresh_token ?? undefined,
      expiry_date: tokenRow.expiry_date ?? undefined,
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    // Map label names -> IDs (only if configured)
    let labelIds: string[] = [];
    if (labelNames.length > 0) {
      const labelsRes = await gmail.users.labels.list({ userId: "me" });
      const labels = labelsRes.data.labels ?? [];
      const labelIdByName = new Map<string, string>();
      labels.forEach((l: gmail_v1.Schema$Label) => {
        const name = l.name || "";
        const id = l.id || "";
        if (name && id) labelIdByName.set(name, id);
      });

      labelIds = labelNames
        .map((n: string) => labelIdByName.get(n))
        .filter((x: string | undefined): x is string => typeof x === "string" && x.length > 0);
    }

    // For optional category hints: link recipients to known contacts by email
    const { data: ce, error: ceErr } = await supabaseAdmin.from("contact_emails").select("contact_id, email").limit(50000);
    if (ceErr) return NextResponse.json({ error: ceErr.message }, { status: 500 });

    const contactIdByEmail = new Map<string, string>();
    (ce ?? []).forEach((row) => {
      const r = row as ContactEmailRow;
      const e = (r.email || "").toLowerCase().trim();
      if (e) contactIdByEmail.set(e, r.contact_id);
    });

    // Also pull contact categories for better labeling when possible
    const { data: contacts, error: cErr } = await supabaseAdmin.from("contacts").select("id, category").limit(20000);
    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });

    const categoryByContactId = new Map<string, string>();
    (contacts ?? []).forEach((r: any) => {
      if (r?.id) categoryByContactId.set(r.id, r.category || "");
    });

    let scanned = 0;
    let messagesFetched = 0;
    let inserted = 0;
    let skipped = 0;

    let pageToken: string | undefined = undefined;

    while (messagesFetched < maxMessages) {
      const res = await gmail.users.messages.list({
        userId: "me",
        // Prefer query; labels optional
        q: query,
        labelIds: labelIds.length > 0 ? ["SENT", ...labelIds] : ["SENT"],
        maxResults: Math.min(100, maxMessages - messagesFetched),
        pageToken,
      });

      const listData = res.data as gmail_v1.Schema$ListMessagesResponse;
      const msgs = listData.messages ?? [];
      pageToken = listData.nextPageToken ?? undefined;

      if (msgs.length === 0) break;

      for (const m of msgs) {
        if (!m.id) continue;
        messagesFetched += 1;

        const full = await gmail.users.messages.get({
          userId: "me",
          id: m.id,
          format: "metadata",
          metadataHeaders: ["To", "Cc", "Bcc", "Subject", "Date"],
        });

        scanned += 1;

        const headers = full.data.payload?.headers ?? [];
        const toEmails = parseEmails(headerValue(headers, "To"));
        const ccEmails = parseEmails(headerValue(headers, "Cc"));
        const bccEmails = parseEmails(headerValue(headers, "Bcc"));
        const allRecipients = Array.from(new Set([...toEmails, ...ccEmails, ...bccEmails]));

        const subject = (headerValue(headers, "Subject") || "").trim();
        const snippet = (full.data.snippet || "").trim();

        // Build a usable “example text”
        const exampleText = (snippet || subject).trim();
        if (!exampleText || exampleText.length < 12) {
          skipped += 1;
          continue;
        }

        // Determine category if possible (contact match wins; else heuristic)
        let contact_category: string | null = null;
        const matchedEmail = allRecipients.find((e) => contactIdByEmail.has(e));
        if (matchedEmail) {
          const cid = contactIdByEmail.get(matchedEmail) || "";
          const cat = (categoryByContactId.get(cid) || "").toLowerCase();
          contact_category = cat || null;
        } else if (allRecipients.length > 0) {
          contact_category = classifyContactCategoryFromEmail(allRecipients[0]);
        }

        // De-dupe: user_id + channel + text
        // (Requires either a unique index, or we do a soft check.)
        const { data: ex, error: exErr } = await supabaseAdmin
          .from("user_voice_examples")
          .select("id")
          .eq("user_id", uid)
          .eq("channel", "email")
          .eq("text", exampleText)
          .limit(1);

        if (!exErr && (ex ?? []).length > 0) {
          skipped += 1;
          continue;
        }

        const { error: insErr } = await supabaseAdmin.from("user_voice_examples").insert({
          user_id: uid,
          channel: "email",
          contact_category,
          intent: "check_in",
          text: exampleText,
        });

        if (insErr) {
          skipped += 1;
          continue;
        }

        inserted += 1;
      }

      if (!pageToken) break;
    }

    return NextResponse.json({
      ok: true,
      scanned,
      messagesFetched,
      inserted,
      skipped,
      usedLabelNames: labelNames,
      usedQuery: query,
      note: "Stores email snippets/subjects as initial voice examples. Add SMS later for texts.",
    });
  } catch (e) {
    const se = safeErr(e);
    console.error("VOICE_FROM_GMAIL_CRASH", se);
    return NextResponse.json({ error: "Voice example import crashed", details: se }, { status: 500 });
  }
}