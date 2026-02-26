import { NextResponse } from "next/server";
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const found = headers.find((h) => (h.name || "").toLowerCase() === name.toLowerCase());
  return found?.value || undefined;
}

function safeEmailFromHeader(v?: string): string | null {
  if (!v) return null;
  const m = v.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { uid?: string; contactId?: string; email?: string; maxThreads?: number };
    const uid = body.uid || "";
    const contactId = body.contactId || "";
    const email = (body.email || "").toLowerCase().trim();
    const maxThreads = Math.min(Math.max(Number(body.maxThreads || 5), 1), 10);

    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
    if (!isUuid(contactId)) return NextResponse.json({ error: "Invalid contactId" }, { status: 400 });
    if (!email) return NextResponse.json({ error: "Missing email" }, { status: 400 });

    const { data: tok } = await supabaseAdmin
      .from("google_tokens")
      .select("access_token, refresh_token, expiry_date")
      .eq("user_id", uid)
      .single();

    if (!tok?.refresh_token) return NextResponse.json({ error: "Google not connected (missing refresh token)" }, { status: 400 });

    const oauth2 = getGoogleOAuthClient();
    oauth2.setCredentials({
      access_token: tok.access_token ?? undefined,
      refresh_token: tok.refresh_token ?? undefined,
      expiry_date: tok.expiry_date ?? undefined,
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    // Identify "me" for outbound detection
    const prof = await gmail.users.getProfile({ userId: "me" });
    const meEmail = (prof.data.emailAddress || "").toLowerCase();

    const q = `(${`from:${email}`} OR ${`to:${email}`}) newer_than:365d`;
    const list = await gmail.users.threads.list({ userId: "me", q, maxResults: maxThreads });

    const threadIds = (list.data.threads ?? []).map((t) => t.id).filter(Boolean) as string[];
    if (threadIds.length === 0) return NextResponse.json({ imported: 0, skipped: 0, threads: 0 });

    let imported = 0;
    let skipped = 0;

    for (const threadId of threadIds) {
      const thr = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });

      const messages = thr.data.messages ?? [];

      for (const msg of messages) {
        const internalDateMs = Number(msg.internalDate || 0);
        const occurredAt = internalDateMs ? new Date(internalDateMs).toISOString() : new Date().toISOString();
        const headers = msg.payload?.headers ?? [];

        const fromHeader = headerValue(headers, "From");
        const subject = headerValue(headers, "Subject") || "";
        const snippet = msg.snippet || "";

        const fromEmail = safeEmailFromHeader(fromHeader) || "";
        const direction: "outbound" | "inbound" = meEmail && fromEmail === meEmail ? "outbound" : "inbound";

        const link = `https://mail.google.com/mail/u/0/#all/${threadId}`;
        const summary = (snippet || subject).trim() || null;

        // Dedupe: gmail + thread link + occurred_at + direction for contact
        const { data: existing, error: exErr } = await supabaseAdmin
          .from("touches")
          .select("id")
          .eq("contact_id", contactId)
          .eq("source", "gmail")
          .eq("source_link", link)
          .eq("occurred_at", occurredAt)
          .eq("direction", direction)
          .limit(1);

        if (exErr) {
          skipped += 1;
          continue;
        }
        if ((existing ?? []).length > 0) {
          skipped += 1;
          continue;
        }

        const { error: insErr } = await supabaseAdmin.from("touches").insert({
          contact_id: contactId,
          channel: "email",
          direction,
          occurred_at: occurredAt,
          intent: "check_in",
          summary,
          source: "gmail",
          source_link: link,
        });

        if (insErr) skipped += 1;
        else imported += 1;
      }
    }

    return NextResponse.json({ imported, skipped, threads: threadIds.length });
  } catch (e: any) {
    console.error("GMAIL_CONTACT_IMPORT_ERROR", e?.message || e);
    return NextResponse.json({ error: "Failed to import Gmail for contact", details: String(e?.message || e) }, { status: 500 });
  }
}