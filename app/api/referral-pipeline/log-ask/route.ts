import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { contact_id, note } = body;

    if (!contact_id) return NextResponse.json({ error: "contact_id required" }, { status: 400 });

    // Verify ownership
    const { data: owned } = await supabaseAdmin
      .from("contacts")
      .select("id, referral_ask_count, referral_ask_notes")
      .eq("id", contact_id)
      .eq("user_id", uid)
      .single();
    if (!owned) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

    const today = new Date().toISOString().slice(0, 10);
    const newCount = (owned.referral_ask_count ?? 0) + 1;

    // Append note with date prefix if provided
    let updatedNotes = owned.referral_ask_notes ?? "";
    if (note?.trim()) {
      const entry = `${today}: ${note.trim()}`;
      updatedNotes = updatedNotes ? `${updatedNotes}\n${entry}` : entry;
    }

    await supabaseAdmin.from("contacts").update({
      last_referral_ask_date: today,
      referral_ask_count: newCount,
      ...(note?.trim() ? { referral_ask_notes: updatedNotes } : {}),
    }).eq("id", contact_id);

    return NextResponse.json({ ok: true, referral_ask_count: newCount });
  } catch (e) {
    return serverError("REFERRAL_LOG_ASK_CRASH", e);
  }
}
