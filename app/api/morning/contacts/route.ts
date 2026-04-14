import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    // getSession reads from cookie — no network round trip to Supabase Auth
    const serverClient = await createSupabaseServerClient();
    const { data: { session } } = await serverClient.auth.getSession();
    const uid = session?.user?.id ?? null;
    if (!uid) return unauthorized();

    // Single DB round trip: contacts + last outbound touch + today/wtd counts
    const { data, error } = await supabaseAdmin.rpc("morning_data", { p_uid: uid });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const nowMs = Date.now();
    const contacts = ((data?.contacts ?? []) as any[]).map((c: any) => ({
      ...c,
      days_since_outbound: c.last_outbound_at
        ? Math.max(0, Math.floor((nowMs - new Date(c.last_outbound_at).getTime()) / 86400000))
        : null,
    }));

    // Attach active deal count per contact (single extra query)
    const contactIds = contacts.map((c: any) => c.id);
    let dealMap: Record<string, number> = {};
    if (contactIds.length > 0) {
      const { data: dealRows } = await supabaseAdmin
        .from("deals")
        .select("contact_id")
        .eq("user_id", uid)
        .eq("status", "active")
        .in("contact_id", contactIds);
      for (const row of dealRows ?? []) {
        dealMap[row.contact_id] = (dealMap[row.contact_id] ?? 0) + 1;
      }
    }

    const contactsWithDeals = contacts.map((c: any) => ({
      ...c,
      active_deals: dealMap[c.id] ?? 0,
    }));

    return NextResponse.json({
      contacts: contactsWithDeals,
      todayCount: data?.today_count ?? 0,
      wtdCount: data?.wtd_count ?? 0,
    });
  } catch (e) {
    return serverError("MORNING_CONTACTS_CRASH", e);
  }
}
