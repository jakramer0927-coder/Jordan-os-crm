import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

// GET /api/pipeline — all active deals with contact info
// GET /api/pipeline?include_closed=1 — include closed deals too (for insights)
export async function GET(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const url = new URL(req.url);
    const includeClosed = url.searchParams.get("include_closed") === "1";

    let query = supabaseAdmin
      .from("deals")
      .select(`
        id, address, role, status, price, close_date, notes, created_at,
        contact_id,
        contacts!contact_id ( id, display_name, category, tier, phone, email ),
        referral_source:referral_source_contact_id ( id, display_name )
      `)
      .eq("user_id", uid)
      .order("close_date", { ascending: true, nullsFirst: false });

    if (!includeClosed) {
      query = query.not("status", "in", '("closed_won","closed_lost")');
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ deals: data ?? [] });
  } catch (e) {
    return serverError("PIPELINE_GET_CRASH", e);
  }
}

// PATCH /api/pipeline — update deal (stage and/or other fields)
export async function PATCH(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { id, status, address, role, price, close_date, notes, referral_source_contact_id } = body;

    const validStatuses = ["lead", "showing", "offer_in", "under_contract", "closed_won", "closed_lost"];
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    if (status && !validStatuses.includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    const updates: Record<string, unknown> = {};
    if (status !== undefined) updates.status = status;
    if (address !== undefined) updates.address = address;
    if (role !== undefined) updates.role = role;
    if (price !== undefined) updates.price = price;
    if (close_date !== undefined) updates.close_date = close_date;
    if (notes !== undefined) updates.notes = notes;
    if (referral_source_contact_id !== undefined) updates.referral_source_contact_id = referral_source_contact_id;

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from("deals")
      .update(updates)
      .eq("id", id)
      .eq("user_id", uid);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("PIPELINE_PATCH_CRASH", e);
  }
}
