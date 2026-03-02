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
 * Accepts:
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

  type Parsed = { sender: string; text: string };
  const out: Parsed[] = [];

  let current: Parsed | null = null;

  for (const line of lines) {
    const m = line.match(msgStart);
    if (m) {
      if (current && current.text.trim()) out.push({ ...current, text: current.text.trim() });
      current = { sender: m[1]!.trim(), text: (m[2] || "").trim() };
    } else {
      if (!current) current = { sender: "Unknown", text: line.trim() };
      else current.text += `\n${line.trim()}`;
    }
  }

  if (current && current.text.trim()) out.push({ ...current, text: current.text.trim() });

  return out.slice(0, 2000);
}

function normalizeSender(s: string) {
  return (s || "").trim().toLowerCase();
}

/**
 * Heuristic: decide if the sender is "me" (outbound) vs "them" (inbound).
 * iMessage exports often use "You".
 * You can expand this list later (Jordan, Jordan Kramer, etc).
 */
function isMeSender(senderRaw: string) {
  const s = normalizeSender(senderRaw);
  if (!s) return false;
  const meSet = new Set([
    "you",
    "me",
    "myself",
    "jordan",
    "jordan kramer",
    "jk",
  ]);
  return meSet.has(s);
}

async function insertInChunks<T>(rows: T[], chunkSize = 500, inserter: (chunk: T[]) => Promise<void>) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    // eslint-disable-next-line no-await-in-loop
    await inserter(rows.slice(i, i + chunkSize));
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
        note: "Thread saved, but no messages were parsed. Raw stored.",
      });
    }

    const toInsert = parsed.map((m) => {
      const outbound = isMeSender(m.sender);
      return {
        user_id: uid,
        thread_id,
        contact_id: contactId,
        direction: outbound ? "outbound" : "inbound", // ✅ REQUIRED
        occurred_at: null, // optional; add timestamp parsing later
        body: m.text,       // ✅ matches schema
        sender: m.sender,   // ✅ REQUIRED
      };
    });

    let inserted = 0;

    await insertInChunks(toInsert, 500, async (chunk) => {
      const { error: msgErr } = await supabaseAdmin.from("text_messages").insert(chunk);
      if (msgErr) throw new Error(msgErr.message);
      inserted += chunk.length;
    });

    return NextResponse.json({
      ok: true,
      thread_id,
      inserted_messages: inserted,
      sample: toInsert.slice(0, 3),
    });
  } catch (e) {
    const se = safeErr(e);
    console.error("IMESSAGE_IMPORT_CRASH", se);
    return NextResponse.json({ error: "iMessage import crashed", details: se }, { status: 500 });
  }
}