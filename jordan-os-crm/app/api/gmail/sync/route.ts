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
  return (matches ?? []).map((e) => e.toLowerCase().trim()).filter(Boolean);
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

function domainOf(email: string): string {
  const parts = email.split("@");
  return (parts[1] || "").toLowerCase().trim();
}

function isConsumerDomain(domain: string): boolean {
  const consumer = new Set([
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "yahoo.co.uk",
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
  return consumer.has(domain);
}

function classifyUnmatched(email: string, subject?: string | null, snippet?: string | null) {
  const d = domainOf(email);
  const text = `${subject || ""} ${snippet || ""}`.toLowerCase();

  const vendorHints = [
    "escrow",
    "title",
    "lender",
    "mortgage",
    "loan",
    "underwriting",
    "appraisal",
    "appraiser",
    "inspection",
    "inspector",
    "staging",
    "stager",
    "contractor",
    "plumber",
    "electric",
    "hvac",
    "roof",
    "pest",
    "termite",
    "photography",
    "photographer",
    "cleaning",
    "cleaner",
    "moving",
    "mover",
    "insurance",
    "warranty",
  ];

  const agentHints = [
    "dre",
    "realtor",
    "real estate",
    "broker",
    "brokerage",
    "listing",
    "offer",
    "open house",
    "showing",
    "mls",
    "compass",
    "sotheby",
    "coldwell",
    "keller",
    "kw",
    "bhhs",
    "berkshire",
    "douglas elliman",
    "the agency",
  ];

  const vendorScore =
    vendorHints.reduce((acc, k) => acc + (d.includes(k) || text.includes(k) ? 1 : 0), 0) +
    (d.includes("escrow") ? 2 : 0) +
    (d.includes("title") ? 2 : 0);

  const agentScore =
    agentHints.reduce((acc, k) => acc + (d.includes(k) || text.includes(k) ? 1 : 0), 0) +
    (d.includes("compass") ? 2 : 0);

  let label: "Agent" | "Vendor" | "ClientLead" | "Unclear" = "Unclear";
  let confidence = 0.55;

  if (vendorScore >= 2 && vendorScore >= agentScore + 1) {
    label = "Vendor";
    confidence = Math.min(0.95, 0.62 + vendorScore * 0.08);
  } else if (agentScore >= 2 && agentScore >= vendorScore + 1) {
    label = "Agent";
    confidence = Math.min(0.95, 0.62 + agentScore * 0.08);
  } else if (isConsumerDomain(d)) {
    label = "ClientLead";
    confidence = 0.65;
  } else {
    label = "Unclear";
    confidence = 0.55;
  }

  return { label, confidence };
}

function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] || email;
  const cleaned = local.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  const titled = cleaned
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return titled || email;
}

async function insertContactEmail(contactId: string, email: string, isPrimary: boolean) {
  const { error } = await supabaseAdmin.from("contact_emails").insert({
    contact_id: contactId,
    email,
    is_primary: isPrimary,
    source: "gmail_auto",
  });

  if (error && !String(error.message || "").toLowerCase().includes("duplicate")) throw error;
}

type UpsertUnmatchedResult = {
  id: string;
  email: string;
  seen_count: number;
  status: string;
  created_contact_id: string | null;
};

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const uid = url.searchParams.get("uid") || "";
    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });

    // Tunables
    const maxMessages = Math.min(Number(url.searchParams.get("max") || "600"), 2000);
    const days = Math.min(Math.max(Number(url.searchParams.get("days") || "365"), 1), 3650);

    // Labels
    const requireLabels = (url.searchParams.get("requireLabels") || "0") === "1";

    // Hybrid auto-create rules
    const autoCreate = (url.searchParams.get("autoCreate") || "1") === "1"; // default ON
    const autoMinSeen = Math.min(Math.max(Number(url.searchParams.get("autoMinSeen") || "3"), 1), 25); // default 3
    const autoMinConfidence = Math.min(Math.max(Number(url.searchParams.get("autoMinConfidence") || "0.78"), 0.5), 0.99); // default 0.78
    const allowClientLeadAutoCreate = (url.searchParams.get("allowClientLeadAutoCreate") || "0") === "1"; // default OFF

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

    // Label IDs (optional)
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
    }

    const appliedLabelIds = requireLabels && labelIds.length > 0 ? [...labelIds, "SENT"] : ["SENT"];

    // Build email->contact_id lookup (contacts.email + contact_emails.email)
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

    // Paginate list
    let pageToken: string | undefined = undefined;
    const collected: Array<{ id: string; threadId?: string }> = [];
    let messagesFetched = 0;

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

    // Stats
    let imported = 0;
    let skipped = 0;
    let unmatched = 0;
    let autoCreated = 0;

    let messagesParsed = 0;
    let matchedRecipients = 0;
    const uniqueRecipientsFound = new Set<string>();

    // Helpful review: top unmatched recipient counts during this run
    const unmatchedCounts = new Map<string, number>();
    const bump = (e: string) => unmatchedCounts.set(e, (unmatchedCounts.get(e) || 0) + 1);

    // Process messages
    for (const m of collected) {
      const full = await gmail.users.messages.get({
        userId: "me",
        id: m.id,
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

      const threadId = full.data.threadId || m.threadId || "";
      const link: string | null = threadId ? `https://mail.google.com/mail/u/0/#all/${threadId}` : null;

      // Match any recipient
      const matchedEmail = allRecipients.find((e: string) => contactIdByEmail.has(e));

      if (!matchedEmail) {
        unmatched += 1;
        allRecipients.forEach((e) => bump(e));

        // Pipeline: store unmatched recipients + maybe auto-create contact
        for (const emailRaw of allRecipients) {
          const email = emailRaw.toLowerCase().trim();
          if (!email) continue;

          // 1) upsert + increment
          const { data: upData, error: upErr } = await supabaseAdmin.rpc("upsert_unmatched_recipient", {
            p_email: email,
            p_last_subject: subject || null,
            p_last_snippet: snippet || null,
            p_last_thread_link: link,
          });

          if (upErr) {
            // don’t crash sync for one bad row
            continue;
          }

          const row = (Array.isArray(upData) ? upData[0] : upData) as UpsertUnmatchedResult | undefined;
          if (!row) continue;

          // Already linked/created? then skip auto-create
          if (row.status === "ignored" || row.status === "linked" || row.status === "auto_created") continue;
          if (row.created_contact_id) continue;

          // 2) Decide if we auto-create a contact
          if (!autoCreate) continue;

          // Don’t create if email already exists in CRM (double safety)
          if (contactIdByEmail.has(email)) continue;

          const cls = classifyUnmatched(email, subject, snippet);

          const allowedType =
            cls.label === "Agent" || cls.label === "Vendor" || (allowClientLeadAutoCreate && cls.label === "ClientLead");

          const shouldCreate = allowedType && cls.confidence >= autoMinConfidence && row.seen_count >= autoMinSeen;

          if (!shouldCreate) continue;

          // Create contact
          const display_name = displayNameFromEmail(email);
          const category = cls.label === "Vendor" ? "Vendor" : cls.label === "ClientLead" ? "Client" : "Agent";
          const tier = "C";

          const { data: created, error: cErr2 } = await supabaseAdmin
            .from("contacts")
            .insert({
              display_name,
              category,
              tier,
              email,
              is_unreviewed: true,
              source_auto: "gmail_unmatched",
            })
            .select("id")
            .single();

          if (cErr2 || !created?.id) continue;

          // Add email to contact_emails so future sync matches instantly
          try {
            await insertContactEmail(created.id, email, true);
          } catch {
            // ignore
          }

          // Mark unmatched as auto_created + linked to contact
          await supabaseAdmin
            .from("unmatched_recipients")
            .update({ status: "auto_created", created_contact_id: created.id })
            .eq("id", row.id);

          // Update lookup map now
          contactIdByEmail.set(email, created.id);
          autoCreated += 1;
        }

        continue;
      }

      matchedRecipients += 1;
      const contactId = contactIdByEmail.get(matchedEmail);
      if (!contactId) {
        unmatched += 1;
        allRecipients.forEach((e) => bump(e));
        continue;
      }

      // Dedupe: contact + source + (thread OR timestamp)
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
      autoCreated,
      messagesFetched,
      messagesParsed,
      matchedRecipients,
      uniqueRecipientsFound: uniqueRecipientsFound.size,
      contactsWithEmail: contactIdByEmail.size,
      topUnmatchedRecipients,
      usedQuery: q,
      requireLabels,
      maxMessages,
      days,
      autoCreate,
      autoMinSeen,
      autoMinConfidence,
      allowClientLeadAutoCreate,
    });
  } catch (e) {
    const se = safeErr(e);
    console.error("GMAIL_SYNC_CRASH", se);
    return NextResponse.json({ error: "Gmail sync crashed", details: se }, { status: 500 });
  }
}