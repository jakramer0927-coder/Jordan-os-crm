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

// PATCH /api/pipeline — update deal stage
export async function PATCH(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { id, status } = body;

    const validStatuses = ["lead", "showing", "offer_in", "under_contract", "closed_won", "closed_lost"];
    if (!id || !validStatuses.includes(status)) {
      return NextResponse.json({ error: "Invalid id or status" }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from("deals")
      .update({ status })
      .eq("id", id)
      .eq("user_id", uid);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("PIPELINE_PATCH_CRASH", e);
  }
}
