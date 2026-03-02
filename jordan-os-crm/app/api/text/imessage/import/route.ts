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

type Parsed = { senderRaw: string; text: string };

function parseIMessage(raw: string): Parsed[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  const msgStart = /^(.{1,60}):\s*(.*)$/;

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

function guessDirectionAndSender(senderRaw: string) {
  const s = (senderRaw || "").toLowerCase().trim();

  // Common paste patterns
  const meAliases = new Set(["you", "me", "jordan", "jordan kramer", "jk"]);
  const themAliases = new Set(["them", "other"]);

  // sender constrained by DB check constraint
  let sender: "me" | "them" = "them";
  let direction: "outbound" | "inbound" = "inbound";

  if (meAliases.has(s)) {
    sender = "me";
    direction = "outbound";
  } else if (themAliases.has(s)) {
    sender = "them";
    direction = "inbound";
  } else {
    // default: treat unknown names as "them"
    sender = "them";
    direction = "inbound";
  }

  return { sender, direction };
}

function chunk<T>(arr: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function makeSummary(messages: Array<{ sender: "me" | "them"; body: string }>) {
  const lastInbound = [...messages].reverse().find((m) => m.sender === "them")?.body || "";
  const lastOutbound = [...messages].reverse().find((m) => m.sender === "me")?.body || "";

  const openQuestion =
    [...messages]
      .reverse()
      .find((m) => m.sender === "me" && m.body.includes("?"))
      ?.body.split("\n")[0]
      .slice(0, 180) || null;

  const topicGuess = (lastInbound || lastOutbound).slice(0, 200);

  return [
    `Topic: ${topicGuess || "—"}`,
    openQuestion ? `Open loop: ${openQuestion}` : `Open loop: —`,
    lastInbound ? `Last inbound: ${lastInbound.slice(0, 180)}` : `Last inbound: —`,
    lastOutbound ? `Last outbound: ${lastOutbound.slice(0, 180)}` : `Last outbound: —`,
  ].join("\n");
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

    // 1) Insert thread
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

    // 2) Parse + normalize + insert messages
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
      const g = guessDirectionAndSender(m.senderRaw);
      return {
        user_id: uid,
        thread_id,
        contact_id: contactId,
        sender: g.sender, // "me" | "them" satisfies sender check
        direction: g.direction, // satisfies direction NOT NULL
        occurred_at: null,
        body: `[${m.senderRaw}] ${m.text}`,
      };
    });

    const chunks = chunk(toInsert, 250);
    let inserted = 0;

    for (const ch of chunks) {
      // eslint-disable-next-line no-await-in-loop
      const { error: msgErr } = await supabaseAdmin.from("text_messages").insert(ch);
      if (msgErr) {
        return NextResponse.json(
          { ok: false, error: msgErr.message, thread_id, inserted_messages: inserted },
          { status: 500 }
        );
      }
      inserted += ch.length;
    }

    // 3) Auto-summary (deterministic)
    const summary = makeSummary(toInsert.map((x) => ({ sender: x.sender, body: x.body })));

    // Best-effort update; if columns don't exist yet, you’ll see the error in response.
    const { error: sumErr } = await supabaseAdmin
      .from("text_threads")
      .update({ summary, last_activity_at: new Date().toISOString() })
      .eq("id", thread_id);

    return NextResponse.json({
      ok: true,
      thread_id,
      inserted_messages: inserted,
      summary_saved: !sumErr,
      summary_error: sumErr ? sumErr.message : null,
      sample: toInsert.slice(0, 3),
    });
  } catch (e) {
    const se = safeErr(e);
    console.error("IMESSAGE_IMPORT_CRASH", se);
    return NextResponse.json({ error: "iMessage import crashed", details: se }, { status: 500 });
  }
}