import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

// GET /api/contacts/deals?contact_id=&uid=
export async function GET(req: Request) {
  const url = new URL(req.url);
  const contact_id = url.searchParams.get("contact_id") || "";
  const uid = url.searchParams.get("uid") || "";

  if (!isUuid(contact_id) || !isUuid(uid))
    return NextResponse.json({ error: "Invalid params" }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from("deals")
    .select("id, address, role, status, price, close_date, notes, created_at")
    .eq("contact_id", contact_id)
    .eq("user_id", uid)
    .order("close_date", { ascending: false, nullsFirst: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deals: data ?? [] });
}

// POST /api/contacts/deals — create or update
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { uid, contact_id, id, address, role, status, price, close_date, notes } = body;

  if (!isUuid(uid) || !isUuid(contact_id))
    return NextResponse.json({ error: "Invalid uid or contact_id" }, { status: 400 });
  if (!address?.trim())
    return NextResponse.json({ error: "Address is required" }, { status: 400 });

  const payload = {
    user_id: uid,
    contact_id,
    address: address.trim(),
    role: role || "buyer",
    status: status || "active",
    price: price ? Number(price) : null,
    close_date: close_date || null,
    notes: notes?.trim() || null,
  };

  if (id && isUuid(id)) {
    // Update
    const { error } = await supabaseAdmin
      .from("deals")
      .update(payload)
      .eq("id", id)
      .eq("user_id", uid);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id });
  }

  // Insert
  const { data, error } = await supabaseAdmin
    .from("deals")
    .insert(payload)
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: (data as any).id });
}

// DELETE /api/contacts/deals
export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { uid, id } = body;

  if (!isUuid(uid) || !isUuid(id))
    return NextResponse.json({ error: "Invalid params" }, { status: 400 });

  const { error } = await supabaseAdmin
    .from("deals")
    .delete()
    .eq("id", id)
    .eq("user_id", uid);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
