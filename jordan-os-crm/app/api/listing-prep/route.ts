import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

const VALID_STATUSES = ["planned", "in_progress", "completed"];

// GET /api/listing-prep?deal_id=xxx
export async function GET(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const url = new URL(req.url);
    const dealId = url.searchParams.get("deal_id");
    if (!dealId) return NextResponse.json({ error: "deal_id required" }, { status: 400 });

    const { data: deal } = await supabaseAdmin
      .from("deals").select("id").eq("id", dealId).eq("user_id", uid).maybeSingle();
    if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

    const { data, error } = await supabaseAdmin
      .from("listing_prep_items")
      .select(`
        id, item_name, vendor_name, cost, status, notes, created_at,
        vendor_contact:vendor_contact_id ( id, display_name )
      `)
      .eq("deal_id", dealId)
      .eq("user_id", uid)
      .order("created_at", { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ items: data ?? [] });
  } catch (e) {
    return serverError("LISTING_PREP_GET_CRASH", e);
  }
}

// POST /api/listing-prep
export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { deal_id, item_name, vendor_contact_id, vendor_name, cost, status = "planned", notes } = body;

    if (!deal_id || !item_name?.trim()) {
      return NextResponse.json({ error: "deal_id and item_name required" }, { status: 400 });
    }
    if (!VALID_STATUSES.includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    const { data: deal } = await supabaseAdmin
      .from("deals").select("id").eq("id", deal_id).eq("user_id", uid).maybeSingle();
    if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

    const { data, error } = await supabaseAdmin
      .from("listing_prep_items")
      .insert({
        deal_id, user_id: uid,
        item_name: item_name.trim(),
        vendor_contact_id: vendor_contact_id || null,
        vendor_name: vendor_name?.trim() || null,
        cost: cost ?? null,
        status,
        notes: notes?.trim() || null,
      })
      .select("id, item_name, vendor_name, cost, status, notes, created_at")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ item: data });
  } catch (e) {
    return serverError("LISTING_PREP_POST_CRASH", e);
  }
}

// PATCH /api/listing-prep
export async function PATCH(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { id, ...fields } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const allowed = ["item_name", "vendor_contact_id", "vendor_name", "cost", "status", "notes"];
    const updates: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in fields) updates[k] = fields[k] === "" ? null : fields[k];
    }
    if (updates.status && !VALID_STATUSES.includes(updates.status as string)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from("listing_prep_items").update(updates).eq("id", id).eq("user_id", uid);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("LISTING_PREP_PATCH_CRASH", e);
  }
}

// DELETE /api/listing-prep
export async function DELETE(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { id } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { error } = await supabaseAdmin
      .from("listing_prep_items").delete().eq("id", id).eq("user_id", uid);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("LISTING_PREP_DELETE_CRASH", e);
  }
}
