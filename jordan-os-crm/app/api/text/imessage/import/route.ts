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
  contact_id?: string | null;
  title?: string | null;
  raw_text: string;
};

/**
 * Minimal parser for iMessage pasted transcripts.
 * Expected common formats:
 * - "Jordan: text..."
 * - "You: text..."
 * - Continuation lines append to previous message
 */
function parseIMessage(raw: string) {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  const msgStart = /^(.{1,40}):\s*(.*)$/;

  type Parsed = { senderRaw: string; text: string };
  const out: Parsed[] = [];

  let current: Parsed | null = null;

  for (const line of lines) {
    const m = line.match(msgStart);
    if (m) {
      if (current && current.text.trim()) out.push({ ...current, text: current.text.trim() });
      current = { senderRaw: m[1]!.trim(), text: (m[2] || "").trim() };
    } else {
      if (!current) current = { senderRaw: "Unknown", text: line.trim() };
      else current.text += `\n${line.trim()}`;
    }
  }

  if (current && current.text.trim()) out.push({ ...current, text: current.text.trim() });

  return out.slice(0, 2000);
}

/**
 * IMPORTANT: your DB has a CHECK constraint on text_messages.sender.
 * We normalize to a safe small set: "me" | "them"
 * (Adjust these literals if your constraint expects different values.)
 */
function normalizeSender(senderRaw: string) {
  const s = (senderRaw || "").trim().toLowerCase();

  // Common iMessage exports
  if (s === "you" || s === "me" || s.includes("jordan")) return "me";

  // Anything else is "them"
  return "them";
}

/**
 * If you want better identification of "me", you can also pass your name via env later.
 * For now, "You"/"Me"/"Jordan" => me.
 */

async function insertInChunks<T>(table: string, rows: T[], chunkSize = 200) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabaseAdmin.from(table).insert(chunk as any);
    if (error) throw new Error(error.message);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const uid = body?.uid || "";
    const contactId = body?.contact_id || null;
    const title = (body?.title || "").trim() || null;
    const rawText = (body?.raw_text || "").trim();

    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
    if (contactId && !isUuid(contactId)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 });
    if (!rawText || rawText.length < 20) return NextResponse.json({ error: "raw_text is too short" }, { status: 400 });

    // 1) Store raw thread
    const { data: threadRow, error: threadErr } = await supabaseAdmin
      .from("text_threads")
      .insert({
        user_id: uid,
        contact_id: contactId,
        title,
        raw_text: rawText,
        source: "imessage_paste",
      })
      .select("id")
      .single();

    if (threadErr || !threadRow) {
      return NextResponse.json({ error: threadErr?.message || "Failed to insert text_threads" }, { status: 500 });
    }

    const thread_id = threadRow.id as string;

    // 2) Parse + store messages
    const parsed = parseIMessage(rawText);

    if (parsed.length === 0) {
      return NextResponse.json({
        ok: true,
        thread_id,
        inserted_messages: 0,
        note: "Thread saved, but no messages were parsed. Raw saved.",
      });
    }

    const nowIso = new Date().toISOString();

    const toInsert = parsed.map((m) => {
      const sender = normalizeSender(m.senderRaw); // MUST satisfy DB check constraint
      const direction = sender === "me" ? "outbound" : "inbound";

      // Preserve original label without violating constraints
      const bodyText =
        m.senderRaw && m.senderRaw.trim().length > 0 && m.senderRaw.trim().toLowerCase() !== sender
          ? `[${m.senderRaw.trim()}] ${m.text}`
          : m.text;

      return {
        user_id: uid,
        thread_id,
        contact_id: contactId,
        sender, // "me" | "them"
        direction, // required by your schema
        occurred_at: null, // we don't have real timestamps from paste; ok if nullable
        body: bodyText,
        created_at: nowIso,
      };
    });

    // Insert in chunks so big threads don’t blow up payload limits
    await insertInChunks("text_messages", toInsert, 200);

    return NextResponse.json({
      ok: true,
      thread_id,
      inserted_messages: toInsert.length,
      sample: toInsert.slice(0, 3),
      note: "sender normalized to satisfy DB constraint; original sender preserved in body prefix.",
    });
  } catch (e) {
    const se = safeErr(e);
    console.error("IMESSAGE_IMPORT_CRASH", se);
    return NextResponse.json({ error: "iMessage import crashed", details: se }, { status: 500 });
  }
}