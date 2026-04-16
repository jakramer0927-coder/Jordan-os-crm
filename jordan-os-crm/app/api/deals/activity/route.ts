import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

const VALID_TYPES = ["note", "price_change", "showing_feedback", "offer", "status_change", "other"];

// GET /api/deals/activity?deal_id=xxx
export async function GET(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const url = new URL(req.url);
    const dealId = url.searchParams.get("deal_id");
    if (!dealId) return NextResponse.json({ error: "deal_id required" }, { status: 400 });

    // Verify user owns this deal
    const { data: deal } = await supabaseAdmin
      .from("deals").select("id").eq("id", dealId).eq("user_id", uid).maybeSingle();
    if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

    const { data, error } = await supabaseAdmin
      .from("deal_activities")
      .select("id, note, activity_type, occurred_at, created_at")
      .eq("deal_id", dealId)
      .eq("user_id", uid)
      .order("occurred_at", { ascending: false })
      .limit(50);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ activities: data ?? [] });
  } catch (e) {
    return serverError("DEAL_ACTIVITY_GET_CRASH", e);
  }
}

// POST /api/deals/activity — add entry
export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { deal_id, note, activity_type = "note" } = body;

    if (!deal_id || !note?.trim()) {
      return NextResponse.json({ error: "deal_id and note required" }, { status: 400 });
    }
    if (!VALID_TYPES.includes(activity_type)) {
      return NextResponse.json({ error: "Invalid activity_type" }, { status: 400 });
    }

    // Verify ownership
    const { data: deal } = await supabaseAdmin
      .from("deals").select("id").eq("id", deal_id).eq("user_id", uid).maybeSingle();
    if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

    const { data, error } = await supabaseAdmin.from("deal_activities").insert({
      deal_id,
      user_id: uid,
      note: note.trim(),
      activity_type,
    }).select("id, note, activity_type, occurred_at").single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ activity: data });
  } catch (e) {
    return serverError("DEAL_ACTIVITY_POST_CRASH", e);
  }
}

// DELETE /api/deals/activity — remove entry
export async function DELETE(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { id } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { error } = await supabaseAdmin
      .from("deal_activities").delete().eq("id", id).eq("user_id", uid);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("DEAL_ACTIVITY_DELETE_CRASH", e);
  }
}
