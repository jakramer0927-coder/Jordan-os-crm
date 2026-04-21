import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

const DEAL_SELECT = `
  id, address, role, status, price, close_date, notes, created_at,
  contact_id, opp_type, buyer_stage, seller_stage, pipeline_status,
  budget_min, budget_max, target_areas, pre_approval_amount, pre_approval_lender,
  motivation, timeline_notes, list_price, estimated_value, market_notes, cma_link,
  target_list_date, commission_pct, referral_fee_pct,
  contacts!contact_id ( id, display_name, category, tier, phone, email ),
  referral_source:referral_source_contact_id ( id, display_name ),
  referral_fee_contact:referral_fee_contact_id ( id, display_name ),
  co_agent:co_agent_contact_id ( id, display_name )
`;

// GET /api/pipeline
// ?type=buyer|seller|investor        — filter by opp_type
// ?pipeline_status=active|past_client|lost  — filter by status (default: active)
// ?include_all=1                      — return all regardless of status (for insights)
export async function GET(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const url = new URL(req.url);
    const typeFilter = url.searchParams.get("type");
    const statusFilter = url.searchParams.get("pipeline_status");
    const includeAll = url.searchParams.get("include_all") === "1";
    // Legacy compat
    const includeClosed = url.searchParams.get("include_closed") === "1";

    let query = supabaseAdmin
      .from("deals")
      .select(DEAL_SELECT)
      .eq("user_id", uid)
      .order("created_at", { ascending: false });

    if (typeFilter) {
      query = query.eq("opp_type", typeFilter);
    }

    if (includeAll || includeClosed) {
      // return everything
    } else if (statusFilter) {
      query = query.eq("pipeline_status", statusFilter);
    } else {
      // default: active only
      query = query.eq("pipeline_status", "active");
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ deals: data ?? [] });
  } catch (e) {
    return serverError("PIPELINE_GET_CRASH", e);
  }
}

// POST /api/pipeline — create a new opportunity
export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const {
      contact_id, opp_type = "buyer", address, role, notes,
      pipeline_status: rawPipelineStatus,
      // Buyer fields
      buyer_stage: rawBuyerStage,
      budget_min, budget_max, target_areas, pre_approval_amount, pre_approval_lender,
      motivation, timeline_notes,
      // Seller fields
      seller_stage: rawSellerStage,
      list_price, estimated_value, market_notes, cma_link, target_list_date,
      // Financial
      price, close_date, commission_pct, referral_fee_pct,
      referral_source_contact_id, referral_fee_contact_id, co_agent_contact_id,
    } = body;

    const isClosed = rawPipelineStatus === "past_client";
    const buyer_stage = isClosed ? "closed" : (rawBuyerStage || "initial_meeting");
    const seller_stage = isClosed ? "sold" : (rawSellerStage || "initial_meeting");
    const pipeline_status = isClosed ? "past_client" : "active";

    if (!contact_id) {
      return NextResponse.json({ error: "contact_id required" }, { status: 400 });
    }

    const { data: contact } = await supabaseAdmin
      .from("contacts").select("id").eq("id", contact_id).eq("user_id", uid).maybeSingle();
    if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

    const insert: Record<string, unknown> = {
      user_id: uid,
      contact_id,
      opp_type,
      pipeline_status,
      role: role || (opp_type === "seller" ? "seller" : "buyer"),
      notes: notes?.trim() || null,
      // Set the appropriate stage
      buyer_stage: opp_type !== "seller" ? (buyer_stage || "initial_meeting") : null,
      seller_stage: opp_type === "seller" ? (seller_stage || "initial_meeting") : null,
      // Keep legacy status in sync
      status: opp_type === "seller"
        ? stageToLegacyStatus(seller_stage || "initial_meeting", "seller")
        : stageToLegacyStatus(buyer_stage || "initial_meeting", "buyer"),
    };

    // Buyer fields
    if (budget_min != null) insert.budget_min = budget_min;
    if (budget_max != null) insert.budget_max = budget_max;
    if (target_areas) insert.target_areas = target_areas;
    if (pre_approval_amount != null) insert.pre_approval_amount = pre_approval_amount;
    if (pre_approval_lender) insert.pre_approval_lender = pre_approval_lender;
    if (motivation) insert.motivation = motivation;
    if (timeline_notes) insert.timeline_notes = timeline_notes;

    // Seller fields — always set address (empty string satisfies legacy NOT NULL constraint)
    insert.address = address?.trim() || "";
    if (list_price != null) insert.list_price = list_price;
    if (estimated_value != null) insert.estimated_value = estimated_value;
    if (market_notes) insert.market_notes = market_notes;
    if (cma_link) insert.cma_link = cma_link;
    if (target_list_date) insert.target_list_date = target_list_date;

    // Financial
    if (price != null) insert.price = price;
    if (close_date) insert.close_date = close_date;
    if (commission_pct != null) insert.commission_pct = commission_pct;
    if (referral_fee_pct != null) insert.referral_fee_pct = referral_fee_pct;
    if (referral_source_contact_id) insert.referral_source_contact_id = referral_source_contact_id;
    if (referral_fee_contact_id) insert.referral_fee_contact_id = referral_fee_contact_id;
    if (co_agent_contact_id) insert.co_agent_contact_id = co_agent_contact_id;

    const { data, error } = await supabaseAdmin
      .from("deals")
      .insert(insert)
      .select(DEAL_SELECT)
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Also insert into opportunity_contacts as primary
    await supabaseAdmin.from("opportunity_contacts").upsert(
      { deal_id: data.id, contact_id, user_id: uid, role: "primary" },
      { onConflict: "deal_id,contact_id" }
    );

    return NextResponse.json({ deal: data });
  } catch (e) {
    return serverError("PIPELINE_POST_CRASH", e);
  }
}

// PATCH /api/pipeline — update opportunity
export async function PATCH(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { id, ...fields } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const allowed = [
      "address", "role", "notes", "opp_type",
      "buyer_stage", "seller_stage", "pipeline_status",
      "budget_min", "budget_max", "target_areas",
      "pre_approval_amount", "pre_approval_lender",
      "motivation", "timeline_notes",
      "list_price", "estimated_value", "market_notes", "cma_link", "target_list_date",
      "price", "close_date", "commission_pct", "referral_fee_pct",
      "referral_source_contact_id", "referral_fee_contact_id", "co_agent_contact_id",
      // Legacy compat
      "status",
    ];

    const updates: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in fields) updates[k] = fields[k] === "" ? null : fields[k];
    }

    // Keep legacy status in sync when stage changes
    if (updates.buyer_stage) {
      updates.status = stageToLegacyStatus(updates.buyer_stage as string, "buyer");
    } else if (updates.seller_stage) {
      updates.status = stageToLegacyStatus(updates.seller_stage as string, "seller");
    }

    // Sync pipeline_status when stage reaches closed/sold
    if (updates.buyer_stage === "closed" || updates.seller_stage === "sold") {
      updates.pipeline_status = "past_client";
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from("deals").update(updates).eq("id", id).eq("user_id", uid);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // When a deal closes, sync close_anniversary + move_in_date to the contact (if not already set)
    if (updates.buyer_stage === "closed" || updates.seller_stage === "sold") {
      const { data: dealRow } = await supabaseAdmin
        .from("deals").select("contact_id, close_date, address").eq("id", id).single();
      if (dealRow?.contact_id && dealRow?.close_date) {
        const { data: existingContact } = await supabaseAdmin
          .from("contacts").select("close_anniversary, move_in_date").eq("id", dealRow.contact_id).single();
        const contactUpdates: Record<string, string> = {};
        if (!existingContact?.close_anniversary) contactUpdates.close_anniversary = dealRow.close_date;
        if (!existingContact?.move_in_date) contactUpdates.move_in_date = dealRow.close_date;
        if (Object.keys(contactUpdates).length > 0) {
          await supabaseAdmin.from("contacts").update(contactUpdates)
            .eq("id", dealRow.contact_id).eq("user_id", uid);
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("PIPELINE_PATCH_CRASH", e);
  }
}

// DELETE /api/pipeline
export async function DELETE(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { id } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const { error } = await supabaseAdmin
      .from("deals").delete().eq("id", id).eq("user_id", uid);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("PIPELINE_DELETE_CRASH", e);
  }
}

function stageToLegacyStatus(stage: string, type: "buyer" | "seller"): string {
  if (type === "buyer") {
    switch (stage) {
      case "initial_meeting":   return "lead";
      case "actively_searching": return "showing";
      case "offer":             return "offer_in";
      case "under_contract":    return "under_contract";
      case "closed":            return "closed_won";
      default:                  return "lead";
    }
  } else {
    switch (stage) {
      case "initial_meeting":   return "lead";
      case "signed_agreement":  return "showing";
      case "listing_prepped":   return "showing";
      case "on_market":         return "offer_in";
      case "in_contract":       return "under_contract";
      case "sold":              return "closed_won";
      default:                  return "lead";
    }
  }
}
