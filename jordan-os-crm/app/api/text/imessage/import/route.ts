import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

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

type Body = {
  uid: string;

  // Optional: attach to a known contact now. (You can link later too.)
  contact_id?: string | null;

  // Optional: shown in UI
  title?: string | null;

  // The iMessage thread pasted as plain text
  raw_text: string;

  /**
   * Optional parsing hints:
   * - my_labels: treat these speaker prefixes as "you/outbound"
   * - other_labels: treat these speaker prefixes as "them/inbound"
   *
   * Example paste format that works well:
   *   You: Hey — quick one...
   *   Ray: Yep, sounds good.
   */
  my_labels?: string[] | null;
  other_labels?: string[] | null;

  /**
   * If true, we keep a single “thread blob” message when we can’t parse speakers.
   * Default true (so you never lose data).
   */
  keep_blob_if_unparsed?: boolean | null;
};

type ParsedMsg = {
  direction: "outbound" | "inbound";
  occurred_at: string | null;
  body: string;
};

// --- iMessage paste parsing helpers ---
//
// We support a few common patterns:
//
// Pattern A (best): "Speaker: message" lines (common from many exports/pastes)
//   You: Hey...
//   Ray: Got it.
//
// Pattern B (some Mac exports): timestamp line then message lines
//   Tue, Feb 27, 2026 at 9:41 AM
//   Ray: Can you...
// (We treat timestamps as "current timestamp context" for subsequent message lines)
//
// Pattern C: When no clear separators exist: we fallback to 1 blob message.

function normalizeLine(s: string) {
  return (s || "").replace(/\u00A0/g, " ").trim(); // nbsp -> space
}

function looksLikeTimestampLine(line: string): boolean {
  const s = line.toLowerCase();

  // examples:
  // "Tue, Feb 27, 2026 at 9:41 AM"
  // "February 27, 2026 at 9:41 AM"
  // "2/27/26, 9:41 AM"
  // "2/27/2026, 09:41"
  const a = /\b(mon|tue|wed|thu|fri|sat|sun)\b.*\b(at)\b.*\b(am|pm)\b/i.test(line);
  const b = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b.*\b(at)\b.*\b(am|pm)\b/i.test(line);
  const c = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b.*\b\d{1,2}:\d{2}\b/i.test(line);
  const d = /\b\d{1,2}:\d{2}\s?(am|pm)\b/i.test(line) && (s.includes("at") || s.includes(","));

  return a || b || c || d;
}

function tryParseTimestamp(line: string): string | null {
  // Best-effort: Date.parse handles many of the above.
  // We do NOT hard-fail on timestamps; null is acceptable.
  const t = Date.parse(line);
  if (Number.isFinite(t)) return new Date(t).toISOString();

  // Sometimes "Tue, Feb 27, 2026 at 9:41 AM" parses; sometimes not depending on locale.
  // If it fails, return null.
  return null;
}

function parseSpeakerLine(
  line: string,
  myLabels: Set<string>,
  otherLabels: Set<string>
): { direction: "outbound" | "inbound"; body: string } | null {
  // Speaker: message
  // NOTE: we only split on the first ":" to preserve URLs etc.
  const idx = line.indexOf(":");
  if (idx <= 0) return null;

  const speakerRaw = normalizeLine(line.slice(0, idx));
  const bodyRaw = normalizeLine(line.slice(idx + 1));

  if (!speakerRaw || !bodyRaw) return null;

  const speaker = speakerRaw.toLowerCase();

  // If user explicitly provides labels, use them.
  if (myLabels.size > 0 || otherLabels.size > 0) {
    if (myLabels.has(speaker)) return { direction: "outbound", body: bodyRaw };
    if (otherLabels.has(speaker)) return { direction: "inbound", body: bodyRaw };
    // unknown speaker — don’t guess
    return null;
  }

  // Default heuristics (safe):
  // "you", "me" => outbound
  // anything else => inbound
  if (speaker === "you" || speaker === "me" || speaker === "myself") {
    return { direction: "outbound", body: bodyRaw };
  }

  return { direction: "inbound", body: bodyRaw };
}

function parseImessagePaste(raw: string, body: Body): { messages: ParsedMsg[]; parsed: boolean } {
  const keepBlob = body.keep_blob_if_unparsed ?? true;

  const myLabels = new Set((body.my_labels ?? []).map((s) => String(s).toLowerCase().trim()).filter(Boolean));
  const otherLabels = new Set((body.other_labels ?? []).map((s) => String(s).toLowerCase().trim()).filter(Boolean));

  const lines = raw
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter((l) => l.length > 0);

  if (lines.length === 0) return { messages: [], parsed: false };

  const out: ParsedMsg[] = [];
  let currentTs: string | null = null;

  // Pass 1: parse speaker lines; update timestamp context when we see a ts line.
  for (const line of lines) {
    if (looksLikeTimestampLine(line)) {
      const ts = tryParseTimestamp(line);
      if (ts) currentTs = ts;
      continue;
    }

    const sp = parseSpeakerLine(line, myLabels, otherLabels);
    if (sp) {
      out.push({
        direction: sp.direction,
        occurred_at: currentTs,
        body: sp.body,
      });
      continue;
    }

    // If line is not a speaker line, we’ll treat it as a continuation of the prior message (common in long texts)
    if (out.length > 0) {
      out[out.length - 1] = {
        ...out[out.length - 1]!,
        body: `${out[out.length - 1]!.body}\n${line}`.trim(),
      };
    } else {
      // no prior message yet — hold it; we’ll handle as blob if needed
    }
  }

  // If we parsed at least 2 messages, we consider it parsed.
  if (out.length >= 2) return { messages: out, parsed: true };

  // If we only got 1 message, it might still be real — keep it.
  if (out.length === 1) return { messages: out, parsed: true };

  // Fallback: blob
  if (keepBlob) {
    return {
      messages: [
        {
          direction: "inbound", // neutral default; you can change later per thread
          occurred_at: null,
          body: lines.join("\n").trim(),
        },
      ],
      parsed: false,
    };
  }

  return { messages: [], parsed: false };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const uid = body?.uid || "";
    const contactId = body?.contact_id || null;
    const title = (body?.title || "iMessage thread").trim();
    const rawText = String(body?.raw_text || "").trim();

    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
    if (contactId && !isUuid(contactId)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 });

    if (!rawText || rawText.length < 10) {
      return NextResponse.json({ error: "raw_text is empty or too short" }, { status: 400 });
    }

    // 1) Insert thread
    const { data: threadRow, error: threadErr } = await supabaseAdmin
      .from("text_threads")
      .insert({
        user_id: uid,
        contact_id: contactId,
        title,
        source: "imessage_paste",
        raw_text: rawText,
      })
      .select("id")
      .single();

    if (threadErr || !threadRow) {
      return NextResponse.json({ error: threadErr?.message || "Failed to create thread" }, { status: 500 });
    }

    const threadId: string = threadRow.id;

    // 2) Parse into messages
    const parsed = parseImessagePaste(rawText, body);
    const msgs = parsed.messages;

    if (msgs.length === 0) {
      return NextResponse.json({
        ok: true,
        thread_id: threadId,
        inserted_messages: 0,
        parsed: false,
        note: "Thread stored but no messages parsed. Provide 'Speaker: message' lines for best parsing.",
      });
    }

    // 3) Insert messages (batch)
    const toInsert = msgs.map((m) => ({
      user_id: uid,
      thread_id: threadId,
      contact_id: contactId,
      direction: m.direction,
      occurred_at: m.occurred_at,
      body: m.body,
    }));

    const { error: msgErr } = await supabaseAdmin.from("text_messages").insert(toInsert);

    if (msgErr) {
      return NextResponse.json(
        {
          error: "Failed to insert parsed messages",
          details: msgErr.message,
          thread_id: threadId,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      thread_id: threadId,
      parsed: parsed.parsed,
      inserted_messages: msgs.length,
      sample: msgs.slice(0, 5),
      note:
        "Tip: Best results when paste lines look like 'You: ...' and 'Name: ...'. You can pass my_labels/other_labels to control direction.",
    });
  } catch (e) {
    const se = safeErr(e);
    console.error("IMESSAGE_IMPORT_CRASH", se);
    return NextResponse.json({ error: "iMessage import crashed", details: se }, { status: 500 });
  }
}