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

    const contactIds = contacts.map((c: any) => c.id);

    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();

    // Attach active deal count, milestones, closed deal dates, referral GCI, and reply rates in parallel
    const [dealRows, milestoneRows, closedDealRows, referralRows, replyRateRows] = await Promise.all([
      contactIds.length > 0
        ? supabaseAdmin.from("deals").select("contact_id").eq("user_id", uid)
            .not("status", "in", '("closed_won","closed_lost")').in("contact_id", contactIds)
        : Promise.resolve({ data: [] }),
      contactIds.length > 0
        ? supabaseAdmin.from("contacts")
            .select("id, birthday, close_anniversary, move_in_date, linkedin_connected_at")
            .in("id", contactIds)
        : Promise.resolve({ data: [] }),
      contactIds.length > 0
        ? supabaseAdmin.from("deals").select("contact_id, address, close_date")
            .eq("user_id", uid).eq("status", "closed_won")
            .not("close_date", "is", null).in("contact_id", contactIds)
        : Promise.resolve({ data: [] }),
      contactIds.length > 0
        ? supabaseAdmin.from("deals").select("referral_source_contact_id, price")
            .eq("user_id", uid).eq("status", "closed_won")
            .not("referral_source_contact_id", "is", null)
            .in("referral_source_contact_id", contactIds)
        : Promise.resolve({ data: [] }),
      contactIds.length > 0
        ? supabaseAdmin.from("touches")
            .select("contact_id, channel, direction")
            .in("contact_id", contactIds)
            .in("channel", ["email", "text"])
            .gte("occurred_at", ninetyDaysAgo)
        : Promise.resolve({ data: [] }),
    ]);

    let dealMap: Record<string, number> = {};
    for (const row of (dealRows as any).data ?? []) {
      dealMap[row.contact_id] = (dealMap[row.contact_id] ?? 0) + 1;
    }

    const milestoneMap: Record<string, { birthday: string | null; close_anniversary: string | null; move_in_date: string | null; linkedin_connected_at: string | null }> = {};
    for (const row of (milestoneRows as any).data ?? []) {
      milestoneMap[row.id] = {
        birthday: row.birthday,
        close_anniversary: row.close_anniversary,
        move_in_date: row.move_in_date,
        linkedin_connected_at: row.linkedin_connected_at,
      };
    }

    const closedDealMap: Record<string, { address: string; close_date: string }[]> = {};
    for (const row of (closedDealRows as any).data ?? []) {
      if (!closedDealMap[row.contact_id]) closedDealMap[row.contact_id] = [];
      closedDealMap[row.contact_id].push({ address: row.address, close_date: row.close_date });
    }

    const referralGciMap: Record<string, number> = {};
    for (const row of (referralRows as any).data ?? []) {
      const id = row.referral_source_contact_id;
      referralGciMap[id] = (referralGciMap[id] ?? 0) + (row.price ?? 0);
    }

    // Per-contact reply rates (last 90 days, email + text channels)
    // Only compute for contacts with ≥3 outbound touches on that channel (avoid misleading %s)
    type ChannelCounts = { out: number; in: number };
    const replyRateRaw: Record<string, { email: ChannelCounts; text: ChannelCounts }> = {};
    for (const row of (replyRateRows as any).data ?? []) {
      if (!replyRateRaw[row.contact_id]) {
        replyRateRaw[row.contact_id] = { email: { out: 0, in: 0 }, text: { out: 0, in: 0 } };
      }
      const ch = row.channel === "email" ? "email" : "text";
      if (row.direction === "outbound") replyRateRaw[row.contact_id][ch].out++;
      else if (row.direction === "inbound") replyRateRaw[row.contact_id][ch].in++;
    }

    const contactsWithDeals = contacts.map((c: any) => {
      const rr = replyRateRaw[c.id];
      const emailRate = rr && rr.email.out >= 3 ? Math.round((rr.email.in / rr.email.out) * 100) : null;
      const textRate = rr && rr.text.out >= 3 ? Math.round((rr.text.in / rr.text.out) * 100) : null;
      return {
        ...c,
        active_deals: dealMap[c.id] ?? 0,
        closed_deal_dates: closedDealMap[c.id] ?? [],
        referral_gci: referralGciMap[c.id] ?? 0,
        gmail_reply_rate: emailRate,
        text_reply_rate: textRate,
        ...(milestoneMap[c.id] ?? { birthday: null, close_anniversary: null, move_in_date: null, linkedin_connected_at: null }),
      };
    });

    return NextResponse.json({
      contacts: contactsWithDeals,
      todayCount: data?.today_count ?? 0,
      wtdCount: data?.wtd_count ?? 0,
    });
  } catch (e) {
    return serverError("MORNING_CONTACTS_CRASH", e);
  }
}
