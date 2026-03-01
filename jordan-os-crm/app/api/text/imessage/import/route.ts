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
 * We keep it tolerant: we store raw + best-effort parsed “messages”.
 *
 * Expected common formats:
 * - "Jordan: text..."
 * - "You: text..."
 * - Timestamps may appear; we do best effort.
 */
function parseIMessage(raw: string) {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  // Heuristic: new message starts when line matches "Name: ..."
  const msgStart = /^(.{1,40}):\s*(.*)$/;

  type Parsed = { sender: string; text: string };
  const out: Parsed[] = [];

  let current: Parsed | null = null;

  for (const line of lines) {
    const m = line.match(msgStart);
    if (m) {
      // flush previous
      if (current && current.text.trim()) out.push({ ...current, text: current.text.trim() });
      current = { sender: m[1]!.trim(), text: (m[2] || "").trim() };
    } else {
      // continuation line
      if (!current) {
        // if we don't have a sender yet, treat as unknown/system
        current = { sender: "Unknown", text: line.trim() };
      } else {
        current.text += `\n${line.trim()}`;
      }
    }
  }

  if (current && current.text.trim()) out.push({ ...current, text: current.text.trim() });

  // Cap to avoid accidentally pasting novels
  const capped = out.slice(0, 2000);

  return capped;
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
    // Create this table if you don’t have it yet:
    //   text_threads(id uuid pk default gen_random_uuid(), user_id uuid, contact_id uuid null, title text null, raw_text text, source text, created_at timestamptz default now())
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
      return NextResponse.json(
        { error: threadErr?.message || "Failed to insert text_threads" },
        { status: 500 }
      );
    }

    const thread_id = threadRow.id as string;

    // 2) Parse + store messages
    // Create this table if you don’t have it yet:
    //   text_messages(id uuid pk default gen_random_uuid(), user_id uuid, contact_id uuid null, thread_id uuid, sender text, body text, created_at timestamptz default now())
    const parsed = parseIMessage(rawText);

    if (parsed.length === 0) {
      return NextResponse.json({
        ok: true,
        thread_id,
        inserted_messages: 0,
        note: "Thread saved, but no messages were parsed. (Paste format didn’t match — still stored raw.)",
      });
    }

    const toInsert = parsed.map((m) => ({
      user_id: uid,
      contact_id: contactId,
      thread_id,
      sender: m.sender,
      body: m.text,
    }));

    const { error: msgErr } = await supabaseAdmin.from("text_messages").insert(toInsert);

    if (msgErr) {
      return NextResponse.json(
        { error: msgErr.message, ok: false, thread_id, inserted_messages: 0 },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      thread_id,
      inserted_messages: toInsert.length,
      sample: toInsert.slice(0, 3),
    });
  } catch (e) {
    const se = safeErr(e);
    console.error("IMESSAGE_IMPORT_CRASH", se);
    return NextResponse.json({ error: "iMessage import crashed", details: se }, { status: 500 });
  }
}