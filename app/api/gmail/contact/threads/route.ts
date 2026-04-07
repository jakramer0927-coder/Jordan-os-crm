import { NextResponse } from "next/server";
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

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

export async function GET(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const url = new URL(req.url);
    const email = (url.searchParams.get("email") || "").toLowerCase().trim();

    if (!email) return NextResponse.json({ error: "Missing email" }, { status: 400 });

    const { data: tok } = await supabaseAdmin
      .from("google_tokens")
      .select("access_token, refresh_token, expiry_date")
      .eq("user_id", uid)
      .single();

    if (!tok?.refresh_token)
      return NextResponse.json(
        { error: "Google not connected (missing refresh token)" },
        { status: 400 },
      );

    const oauth2 = getGoogleOAuthClient();
    oauth2.setCredentials({
      access_token: tok.access_token ?? undefined,
      refresh_token: tok.refresh_token ?? undefined,
      expiry_date: tok.expiry_date ?? undefined,
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    // Search last 10 threads involving this email (either direction)
    // "newer_than:365d" keeps it light; adjust later.
    const q = `(${`from:${email}`} OR ${`to:${email}`}) newer_than:365d`;

    const list = await gmail.users.threads.list({
      userId: "me",
      q,
      maxResults: 10,
    });

    const threads = list.data.threads ?? [];

    // Fetch thread metadata for preview (subject/date/snippet + deep link)
    const previews = [];
    for (const t of threads) {
      if (!t.id) continue;

      const thr = await gmail.users.threads.get({
        userId: "me",
        id: t.id,
        format: "metadata",
        metadataHeaders: ["Subject", "Date", "From", "To"],
      });

      const messages = thr.data.messages ?? [];
      const lastMsg = messages[messages.length - 1];
      const headers = lastMsg?.payload?.headers ?? [];

      const subject = headerValue(headers, "Subject") || "(no subject)";
      const date = headerValue(headers, "Date") || "";
      const from = headerValue(headers, "From") || "";
      const to = headerValue(headers, "To") || "";
      const snippet = lastMsg?.snippet || "";

      previews.push({
        threadId: t.id,
        subject,
        date,
        from,
        to,
        snippet,
        link: `https://mail.google.com/mail/u/0/#all/${t.id}`,
        messageCount: messages.length,
      });
    }

    return NextResponse.json({ email, q, threads: previews });
  } catch (e: any) {
    console.error("GMAIL_CONTACT_THREADS_ERROR", e?.message || e);
    return NextResponse.json(
      { error: "Failed to search Gmail threads", details: String(e?.message || e) },
      { status: 500 },
    );
  }
}
