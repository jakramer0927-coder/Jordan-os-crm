import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

// POST /api/contacts — create a new contact
export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { display_name, category, tier, phone, email, notes } = body;

    if (!display_name?.trim()) {
      return NextResponse.json({ error: "display_name is required" }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin.from("contacts").insert({
      user_id: uid,
      display_name: display_name.trim(),
      category: category ?? "sphere",
      tier: tier || null,
      phone: phone?.trim() || null,
      email: email?.trim().toLowerCase() || null,
      notes: notes?.trim() || null,
    }).select("id").single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: data.id });
  } catch (e) {
    return serverError("CONTACTS_CREATE_CRASH", e);
  }
}
