import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

const VALID_OUTCOMES = ["pending", "accepted", "countered", "rejected", "withdrawn"];

// GET /api/offers?deal_id=xxx
export async function GET(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const url = new URL(req.url);
    const dealId = url.searchParams.get("deal_id");
    if (!dealId) return NextResponse.json({ error: "deal_id required" }, { status: 400 });

    // Verify ownership
    const { data: deal } = await supabaseAdmin
      .from("deals").select("id").eq("id", dealId).eq("user_id", uid).maybeSingle();
    if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

    const { data, error } = await supabaseAdmin
      .from("offers")
      .select(`
        id, property_address, offer_price, asking_price, terms_notes,
        competing_offers_count, seller_agent_name, outcome, accepted_price,
        cma_link, closed_price, listing_link, occurred_at, created_at,
        seller_agent_contact:seller_agent_contact_id ( id, display_name )
      `)
      .eq("deal_id", dealId)
      .eq("user_id", uid)
      .order("occurred_at", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ offers: data ?? [] });
  } catch (e) {
    return serverError("OFFERS_GET_CRASH", e);
  }
}

// POST /api/offers
export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const {
      deal_id, property_address, offer_price, asking_price, terms_notes,
      competing_offers_count, seller_agent_contact_id, seller_agent_name,
      outcome = "pending", accepted_price, cma_link, closed_price, listing_link, occurred_at,
    } = body;

    if (!deal_id || !property_address?.trim()) {
      return NextResponse.json({ error: "deal_id and property_address required" }, { status: 400 });
    }
    if (!VALID_OUTCOMES.includes(outcome)) {
      return NextResponse.json({ error: "Invalid outcome" }, { status: 400 });
    }

    const { data: deal } = await supabaseAdmin
      .from("deals").select("id").eq("id", deal_id).eq("user_id", uid).maybeSingle();
    if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

    const { data, error } = await supabaseAdmin
      .from("offers")
      .insert({
        deal_id, user_id: uid,
        property_address: property_address.trim(),
        offer_price: offer_price ?? null,
        asking_price: asking_price ?? null,
        terms_notes: terms_notes?.trim() || null,
        competing_offers_count: competing_offers_count ?? null,
        seller_agent_contact_id: seller_agent_contact_id || null,
        seller_agent_name: seller_agent_name?.trim() || null,
        outcome,
        accepted_price: accepted_price ?? null,
        cma_link: cma_link?.trim() || null,
        closed_price: closed_price ?? null,
        listing_link: listing_link?.trim() || null,
        occurred_at: occurred_at || new Date().toISOString(),
      })
      .select("id, property_address, offer_price, asking_price, outcome, occurred_at")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ offer: data });
  } catch (e) {
    return serverError("OFFERS_POST_CRASH", e);
  }
}

// PATCH /api/offers
export async function PATCH(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { id, ...fields } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const allowed = [
      "property_address", "offer_price", "asking_price", "terms_notes",
      "competing_offers_count", "seller_agent_contact_id", "seller_agent_name",
      "outcome", "accepted_price", "cma_link", "closed_price", "listing_link", "occurred_at",
    ];
    const updates: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in fields) updates[k] = fields[k] === "" ? null : fields[k];
    }
    if (updates.outcome && !VALID_OUTCOMES.includes(updates.outcome as string)) {
      return NextResponse.json({ error: "Invalid outcome" }, { status: 400 });
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from("offers").update(updates).eq("id", id).eq("user_id", uid);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("OFFERS_PATCH_CRASH", e);
  }
}

// DELETE /api/offers
export async function DELETE(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { id } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { error } = await supabaseAdmin
      .from("offers").delete().eq("id", id).eq("user_id", uid);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("OFFERS_DELETE_CRASH", e);
  }
}
