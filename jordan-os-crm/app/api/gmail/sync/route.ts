import { NextResponse } from "next/server";
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function parseEmails(headerVal?: string): string[] {
  if (!headerVal) return [];
  const matches = headerVal.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return (matches ?? []).map((e) => e.toLowerCase());
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const found = headers.find((h) => (h.name || "").toLowerCase() === name.toLowerCase());
  return found?.value || undefined;
}

function safeErr(e: unknown) {
  const anyE = e as any;
  return {
    message: String(anyE?.message || anyE || "Unknown error"),
    name: String(anyE?.name || ""),
    stack: typeof anyE?.stack === "string" ? anyE.stack.split("\n").slice(0, 14).join("\n") : "",
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const uid = url.searchParams.get("uid") || "";
    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });

    // Tunables
    const maxMessages = Math.min(Number(url.searchParams.get("max") || "400"), 2000);
    const days = Math.min(Math.max(Number(url.searchParams.get("days") || "365"), 1), 3650);

    // Labels behavior:
    // - default: labels NOT required (sync all sent)
    // - requireLabels=1: restrict to configured labels
    const requireLabels = (url.searchParams.get("requireLabels") || "0") === "1";

    // Load tokens
    const { data: tok, error: tokErr } = await supabaseAdmin
      .from("google_tokens")
      .select("access_token, refresh_token, expiry_date")
      .eq("user_id", uid)
      .single();

    if (tokErr || !tok) return NextResponse.json({ error: "Google not connected" }, { status: 400 });
    if (!tok.refresh_token) return NextResponse.json({ error: "Missing refresh token (reconnect Google)" }, { status: 400 });

    // Load settings (labels)
    const { data: settings, error: setErr } = await supabaseAdmin
      .from("user_settings")
      .select("gmail_label_names")
      .eq("user_id", uid)
      .maybeSingle();

    if (setErr) return NextResponse.json({ error: setErr.message }, { status: 500 });

    const labelNames = (settings?.gmail_label_names || "")
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    if (requireLabels && labelNames.length === 0) {
      return NextResponse.json({ error: "No Gmail labels configured in settings (requireLabels=1)." }, { status: 400 });
    }

    const oauth2 = getGoogleOAuthClient();
    oauth2.setCredentials({
      access_token: tok.access_token ?? undefined,
      refresh_token: tok.refresh_token ?? undefined,
      expiry_date: tok.expiry_date ?? undefined,
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    // Map label names -> label IDs (if provided)
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

      if (requireLabels && labelIds.length === 0) {
        return NextResponse.json(
          { error: `None of the configured labels were found in Gmail. Configured: ${labelNames.join(", ")}` },
          { status: 400 }
        );
      }
      // If not required and not found, we ignore labels.
    }

    // Labels ONLY applied when requireLabels=1
    const appliedLabelIds = requireLabels && labelIds.length > 0 ? [...labelIds, "SENT"] : ["SENT"];

    // Build email->contact_id lookup from:
    // - contacts.email
    // - contact_emails.email
    const contactIdByEmail = new Map<string, string>();

    const { data: contacts, error: cErr } = await supabaseAdmin
      .from("contacts")
      .select("id, email")
      .not("email", "is", null)
      .limit(20000);

    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });

    (contacts ?? []).forEach((c: { id: string; email: string | null }) => {
      const e = (c.email || "").toLowerCase().trim();
      if (e && !contactIdByEmail.has(e)) contactIdByEmail.set(e, c.id);
    });

    const { data: extraEmails, error: eErr } = await supabaseAdmin
      .from("contact_emails")
      .select("contact_id, email")
      .limit(50000);

    if (eErr) return NextResponse.json({ error: eErr.message }, { status: 500 });

    (extraEmails ?? []).forEach((r: { contact_id: string; email: string }) => {
      const e = (r.email || "").toLowerCase().trim();
      if (e && !contactIdByEmail.has(e)) contactIdByEmail.set(e, r.contact_id);
    });

    // Query: sent mail from me within window
    const q = `in:sent from:me newer_than:${days}d`;

    let imported = 0;
    let skipped = 0;
    let unmatched = 0;

    let messagesFetched = 0;
    let messagesParsed = 0;
    let matchedRecipients = 0;
    const uniqueRecipientsFound = new Set<string>();

    // Track top unmatched recipients (so you can decide what to add)
    const unmatchedCounts = new Map<string, number>();
    const bumpUnmatched = (e: string) => unmatchedCounts.set(e, (unmatchedCounts.get(e) || 0) + 1);

    // Paginate Gmail list
    let pageToken: string | undefined = undefined;
    const collected: Array<{ id: string; threadId?: string }> = [];

    while (collected.length < maxMessages) {
      const resp: gmail_v1.Schema$ListMessagesResponse =
        (
          await gmail.users.messages.list({
            userId: "me",
            q,
            labelIds: appliedLabelIds,
            maxResults: Math.min(500, maxMessages - collected.length),
            pageToken,
          })
        ).data;

      const msgs = resp.messages ?? [];
      messagesFetched += msgs.length;

      for (const m of msgs) {
        if (m.id) collected.push({ id: m.id, threadId: m.threadId || undefined });
      }

      pageToken = resp.nextPageToken || undefined;
      if (!pageToken || msgs.length === 0) break;
    }

    // Process messages
    for (const m of collected) {
      const id = m.id;

      const full = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["To", "Cc", "Bcc", "Subject", "Date"],
      });

      messagesParsed += 1;

      const headers = full.data.payload?.headers ?? [];
      const toEmails = parseEmails(headerValue(headers, "To"));
      const ccEmails = parseEmails(headerValue(headers, "Cc"));
      const bccEmails = parseEmails(headerValue(headers, "Bcc"));

      const allRecipients = Array.from(new Set([...toEmails, ...ccEmails, ...bccEmails]));
      allRecipients.forEach((e) => uniqueRecipientsFound.add(e));

      const subject = headerValue(headers, "Subject") || "";
      const internalDateMs = Number(full.data.internalDate || 0);
      const occurredAt = internalDateMs ? new Date(internalDateMs).toISOString() : new Date().toISOString();
      const snippet = full.data.snippet || "";

      const matchedEmail = allRecipients.find((e: string) => contactIdByEmail.has(e));
      if (!matchedEmail) {
        unmatched += 1;
        allRecipients.forEach((e) => bumpUnmatched(e));
        continue;
      }

      matchedRecipients += 1;

      const contactId = contactIdByEmail.get(matchedEmail);
      if (!contactId) {
        unmatched += 1;
        allRecipients.forEach((e) => bumpUnmatched(e));
        continue;
      }

      const threadId = full.data.threadId || m.threadId || "";
      const link: string | null = threadId ? `https://mail.google.com/mail/u/0/#all/${threadId}` : null;

      // Dedupe: contact + source + (thread link + timestamp)
      const { data: existing, error: exErr } = await supabaseAdmin
        .from("touches")
        .select("id")
        .eq("contact_id", contactId)
        .eq("source", "gmail")
        .or(link ? `source_link.eq.${link},occurred_at.eq.${occurredAt}` : `occurred_at.eq.${occurredAt}`)
        .limit(1);

      if (exErr) {
        skipped += 1;
        continue;
      }
      if ((existing ?? []).length > 0) {
        skipped += 1;
        continue;
      }

      const summary = (snippet || subject).trim() || null;

      const { error: insErr } = await supabaseAdmin.from("touches").insert({
        contact_id: contactId,
        channel: "email",
        direction: "outbound",
        occurred_at: occurredAt,
        intent: "check_in",
        summary,
        source: "gmail",
        source_link: link,
      });

      if (insErr) {
        skipped += 1;
        continue;
      }

      imported += 1;
    }

    const topUnmatchedRecipients = Array.from(unmatchedCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([email, count]) => ({ email, count }));

    return NextResponse.json({
      imported,
      skipped,
      unmatched,
      messagesFetched,
      messagesParsed,
      matchedRecipients,
      uniqueRecipientsFound: uniqueRecipientsFound.size,
      contactsWithEmail: contactIdByEmail.size,
      topUnmatchedRecipients,
      usedQuery: q,
      requireLabels,
      usedLabelNames: labelNames,
      usedLabelIds: labelIds,
      appliedLabelIds,
      maxMessages,
      days,
    });
  } catch (e) {
    const se = safeErr(e);
    console.error("GMAIL_SYNC_CRASH", se);
    return NextResponse.json(
      {
        error: "Gmail sync crashed",
        details: se,
      },
      { status: 500 }
    );
  }
}