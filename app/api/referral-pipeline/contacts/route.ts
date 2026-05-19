import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

    // Contacts eligible for referral ask: Client/Sphere/Agent tier A or B,
    // not archived, not asked in last 90 days
    const { data: contacts, error } = await supabaseAdmin
      .from("contacts")
      .select("id, display_name, category, tier, client_type, email, phone, last_referral_ask_date, referral_ask_count, life_event_flags, last_interaction_at")
      .eq("user_id", uid)
      .in("category", ["Client", "Sphere", "Agent"])
      .in("tier", ["A", "B"])
      .or(`last_referral_ask_date.is.null,last_referral_ask_date.lt.${ninetyDaysAgo}`)
      .neq("archived", true)
      .order("last_referral_ask_date", { ascending: true, nullsFirst: true })
      .limit(100);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const contactIds = (contacts ?? []).map((c: any) => c.id);

    // Get last touch date for each contact
    const lastTouches: Record<string, string | null> = {};
    if (contactIds.length > 0) {
      const { data: touches } = await supabaseAdmin
        .from("touches")
        .select("contact_id, occurred_at")
        .in("contact_id", contactIds)
        .order("occurred_at", { ascending: false });

      for (const t of touches ?? []) {
        if (!lastTouches[t.contact_id]) lastTouches[t.contact_id] = t.occurred_at;
      }
    }

    // Get last interaction note summary for each contact
    const lastNoteSummaries: Record<string, string | null> = {};
    if (contactIds.length > 0) {
      const { data: notes } = await supabaseAdmin
        .from("interaction_notes")
        .select("contact_id, summary")
        .in("contact_id", contactIds)
        .order("created_at", { ascending: false });

      for (const n of notes ?? []) {
        if (!lastNoteSummaries[n.contact_id]) lastNoteSummaries[n.contact_id] = n.summary;
      }
    }

    // Get closed deal summaries for context
    const closedDeals: Record<string, string[]> = {};
    if (contactIds.length > 0) {
      const { data: deals } = await supabaseAdmin
        .from("deals")
        .select("contact_id, address, close_date, role")
        .in("contact_id", contactIds)
        .eq("status", "closed_won")
        .order("close_date", { ascending: false });

      for (const d of deals ?? []) {
        if (!closedDeals[d.contact_id]) closedDeals[d.contact_id] = [];
        closedDeals[d.contact_id].push(
          `${d.role ?? "deal"}: ${d.address}${d.close_date ? ` (${new Date(d.close_date).toLocaleDateString("en-US", { month: "short", year: "numeric" })})` : ""}`
        );
      }
    }

    const enriched = (contacts ?? []).map((c: any) => ({
      ...c,
      last_touch_date: lastTouches[c.id] ?? null,
      last_interaction_summary: lastNoteSummaries[c.id] ?? null,
      transaction_history: closedDeals[c.id]?.join(", ") ?? null,
    }));

    // Sort by last touch date descending (most recently touched first)
    enriched.sort((a: any, b: any) => {
      if (!a.last_touch_date && !b.last_touch_date) return 0;
      if (!a.last_touch_date) return 1;
      if (!b.last_touch_date) return -1;
      return new Date(b.last_touch_date).getTime() - new Date(a.last_touch_date).getTime();
    });

    return NextResponse.json({ contacts: enriched, total: enriched.length });
  } catch (e) {
    return serverError("REFERRAL_PIPELINE_CONTACTS_CRASH", e);
  }
}
