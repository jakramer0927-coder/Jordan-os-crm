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

    // ── Referral potential scoring ────────────────────────────────────────────
    // Build a profile from contacts who have already sent referrals, then score
    // every unactivated contact by similarity. Requires ≥3 known sources to be
    // meaningful — below that threshold we skip to avoid misleading signals.
    const sources = contactsWithDeals.filter((c: any) => (c.referral_gci ?? 0) > 0);

    let contactsWithPotential = contactsWithDeals;

    if (sources.length >= 3) {
      // Compute profile
      const catCounts: Record<string, number> = {};
      const tierCounts: Record<string, number> = {};
      let linkedinCount = 0;
      let totalReplyRate = 0;
      let replyRateN = 0;

      for (const s of sources) {
        const cat = (s.category || "other").toLowerCase();
        catCounts[cat] = (catCounts[cat] ?? 0) + 1;
        const tier = (s.tier || "none").toUpperCase();
        tierCounts[tier] = (tierCounts[tier] ?? 0) + 1;
        if (s.linkedin_connected_at) linkedinCount++;
        const best = Math.max(s.gmail_reply_rate ?? 0, s.text_reply_rate ?? 0);
        if (best > 0) { totalReplyRate += best; replyRateN++; }
      }

      const n = sources.length;
      const catWeights: Record<string, number> = Object.fromEntries(
        Object.entries(catCounts).map(([k, v]) => [k, (v as number) / n])
      );
      const tierWeights: Record<string, number> = Object.fromEntries(
        Object.entries(tierCounts).map(([k, v]) => [k, (v as number) / n])
      );
      const linkedinRate = linkedinCount / n;
      const avgReplyRate = replyRateN > 0 ? totalReplyRate / replyRateN : 0;

      contactsWithPotential = contactsWithDeals.map((c: any) => {
        // Already a referral source — no need to score
        if ((c.referral_gci ?? 0) > 0) return { ...c, referral_potential: 0 };

        let score = 0;
        const cat = (c.category || "other").toLowerCase();
        const tier = (c.tier || "none").toUpperCase();
        const bestReplyRate = Math.max(c.gmail_reply_rate ?? 0, c.text_reply_rate ?? 0);

        // Category match (0–30): strongest predictor
        score += Math.round((catWeights[cat] ?? 0) * 30);

        // Tier match (0–20)
        score += Math.round((tierWeights[tier] ?? 0) * 20);

        // LinkedIn match (0–10): if most sources are LinkedIn connections
        if (c.linkedin_connected_at && linkedinRate >= 0.3) score += 10;

        // Reply engagement (0–15)
        if (bestReplyRate >= avgReplyRate && bestReplyRate > 0) score += 15;
        else if (bestReplyRate > 0) score += 7;

        // Tier A/B absolute bonus — high-value relationships are better bets
        if (tier === "A") score += 10;
        else if (tier === "B") score += 5;

        return { ...c, referral_potential: Math.min(100, score) };
      });
    } else {
      // Not enough source data — set 0 for all
      contactsWithPotential = contactsWithDeals.map((c: any) => ({ ...c, referral_potential: 0 }));
    }

    return NextResponse.json({
      contacts: contactsWithPotential,
      todayCount: data?.today_count ?? 0,
      wtdCount: data?.wtd_count ?? 0,
    });
  } catch (e) {
    return serverError("MORNING_CONTACTS_CRASH", e);
  }
}
