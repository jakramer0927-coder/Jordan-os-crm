import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function safeStr(v: unknown, max = 8000): string {
  const s = String(v ?? "").trim();
  return s.slice(0, max);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const uid = safeStr(body?.uid, 100);
    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });

    const contact_id = body?.contact_id ? safeStr(body.contact_id, 100) : null;
    if (contact_id && !isUuid(contact_id)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 });

    const channel = safeStr(body?.channel, 30);
    const intent = body?.intent ? safeStr(body.intent, 40) : null;
    const contact_category = body?.contact_category ? safeStr(body.contact_category, 40) : null;

    const draft_text = safeStr(body?.draft_text, 20000);
    const final_text = safeStr(body?.final_text, 20000);

    const ratingRaw = body?.rating;
    const rating = ratingRaw === 1 || ratingRaw === -1 ? ratingRaw : null;

    const notes = body?.notes ? safeStr(body.notes, 2000) : null;

    if (!draft_text || !final_text) {
      return NextResponse.json({ error: "Missing draft_text or final_text" }, { status: 400 });
    }

    const { error } = await supabaseAdmin.from("draft_feedback").insert({
      user_id: uid,
      contact_id,
      channel,
      intent,
      contact_category,
      draft_text,
      final_text,
      rating,
      notes,
    });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e || "Unknown error") }, { status: 500 });
  }
}