import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

// GET /api/opportunity-contacts?deal_id=xxx
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
      .from("opportunity_contacts")
      .select(`
        id, role, created_at,
        contact:contact_id ( id, display_name, category, tier, phone, email )
      `)
      .eq("deal_id", dealId)
      .eq("user_id", uid)
      .order("created_at", { ascending: true });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ contacts: data ?? [] });
  } catch (e) {
    return serverError("OPP_CONTACTS_GET_CRASH", e);
  }
}

// POST /api/opportunity-contacts
export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { deal_id, contact_id, role = "primary" } = body;

    if (!deal_id || !contact_id) {
      return NextResponse.json({ error: "deal_id and contact_id required" }, { status: 400 });
    }

    const { data: deal } = await supabaseAdmin
      .from("deals").select("id").eq("id", deal_id).eq("user_id", uid).maybeSingle();
    if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

    const { data, error } = await supabaseAdmin
      .from("opportunity_contacts")
      .upsert({ deal_id, contact_id, user_id: uid, role }, { onConflict: "deal_id,contact_id" })
      .select("id, role")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ contact: data });
  } catch (e) {
    return serverError("OPP_CONTACTS_POST_CRASH", e);
  }
}

// DELETE /api/opportunity-contacts
export async function DELETE(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { id } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { error } = await supabaseAdmin
      .from("opportunity_contacts").delete().eq("id", id).eq("user_id", uid);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("OPP_CONTACTS_DELETE_CRASH", e);
  }
}
