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

type ParsedLine = {
  sender_raw: string; // original name in transcript
  sender: "me" | "them";
  direction: "outbound" | "inbound";
  body: string; // message text
  occurred_at: string | null; // we’re not parsing timestamps yet
};

function normalizeSender(name: string): { sender: "me" | "them"; direction: "outbound" | "inbound" } {
  const n = (name || "").trim().toLowerCase();

  // common “me” patterns from iMessage exports/pastes
  const meNames = new Set(["you", "me", "jordan", "jordan kramer"]);

  if (meNames.has(n) || n.includes("you")) return { sender: "me", direction: "outbound" };

  return { sender: "them", direction: "inbound" };
}

/**
 * Minimal parser for iMessage pasted transcripts.
 * Format we support best:
 *   Name: message
 * continuation lines appended until next Name:
 */
function parseIMessage(raw: string): ParsedLine[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  const msgStart = /^(.{1,60}):\s*(.*)$/;

  let current: { sender_raw: string; text: string } | null = null;
  const out: ParsedLine[] = [];

  function flush() {
    if (!current) return;
    const text = current.text.trim();
    if (!text) return;

    const norm = normalizeSender(current.sender_raw);
    // preserve original speaker label in body prefix (helps later)
    const body = `[${current.sender_raw}] ${text}`;

    out.push({
      sender_raw: current.sender_raw,
      sender: norm.sender,
      direction: norm.direction,
      occurred_at: null,
      body,
    });
  }

  for (const line of lines) {
    const m = line.match(msgStart);
    if (m) {
      flush();
      current = { sender_raw: m[1]!.trim(), text: (m[2] || "").trim() };
    } else {
      if (!current) current = { sender_raw: "Unknown", text: line.trim() };
      else current.text += `\n${line.trim()}`;
    }
  }

  flush();

  // protect against absurd pastes
  return out.slice(0, 2000);
}

async function insertInChunks<T extends object>(table: string, rows: T[], chunkSize = 200) {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    // eslint-disable-next-line no-await-in-loop
    const { error } = await supabaseAdmin.from(table).insert(chunk);
    if (error) throw new Error(error.message);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const uid = body?.uid || "";
    const contactId = body?.contact_id ?? null;
    const title = (body?.title || "").trim() || null;
    const rawText = (body?.raw_text || "").trim();

    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
    if (contactId && !isUuid(contactId)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 });
    if (!rawText || rawText.length < 20) return NextResponse.json({ error: "raw_text is too short" }, { status: 400 });

    // 1) Save thread
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

    // 2) Parse + insert messages
    const parsed = parseIMessage(rawText);

    if (parsed.length === 0) {
      return NextResponse.json({
        ok: true,
        thread_id,
        inserted_messages: 0,
        note: "Thread saved, but no messages were parsed. Raw thread still stored.",
      });
    }

    const nowIso = new Date().toISOString();

    const toInsert = parsed.map((m) => ({
      user_id: uid,
      thread_id,
      contact_id: contactId,
      sender: m.sender, // must satisfy DB check constraint
      direction: m.direction,
      occurred_at: m.occurred_at,
      body: m.body,
      created_at: nowIso,
    }));

    await insertInChunks("text_messages", toInsert, 200);

    // Auto-extract context if contact is known (fire-and-forget, don't block response)
    if (contactId) {
      fetch(`${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/api/contacts/extract_context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, contact_id: contactId }),
      }).catch(() => {/* ignore */});
    }

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