import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();

    const [contactsRes, referralDealsRes, replyRateRes] = await Promise.all([
      supabaseAdmin
        .from("contacts")
        .select("id, display_name, category, tier, linkedin_connected_at, last_contact_at")
        .eq("user_id", uid)
        .eq("archived", false),

      supabaseAdmin
        .from("deals")
        .select("referral_source_contact_id, price")
        .eq("user_id", uid)
        .eq("status", "closed_won")
        .not("referral_source_contact_id", "is", null),

      supabaseAdmin
        .from("touches")
        .select("contact_id, channel, direction")
        .eq("user_id", uid)
        .in("channel", ["email", "text"])
        .gte("occurred_at", ninetyDaysAgo),
    ]);

    const contacts = contactsRes.data ?? [];
    const nowMs = Date.now();

    // Build referral GCI map
    const referralGciMap: Record<string, number> = {};
    for (const row of referralDealsRes.data ?? []) {
      const id = row.referral_source_contact_id;
      referralGciMap[id] = (referralGciMap[id] ?? 0) + (row.price ?? 0);
    }

    // Build reply rate map
    type ChCounts = { out: number; in: number };
    const rrRaw: Record<string, { email: ChCounts; text: ChCounts }> = {};
    for (const row of replyRateRes.data ?? []) {
      if (!rrRaw[row.contact_id]) rrRaw[row.contact_id] = { email: { out: 0, in: 0 }, text: { out: 0, in: 0 } };
      const ch = row.channel === "email" ? "email" : "text";
      if (row.direction === "outbound") rrRaw[row.contact_id][ch].out++;
      else if (row.direction === "inbound") rrRaw[row.contact_id][ch].in++;
    }
    const bestReplyRate = (id: string) => {
      const rr = rrRaw[id];
      if (!rr) return 0;
      const e = rr.email.out >= 3 ? Math.round((rr.email.in / rr.email.out) * 100) : 0;
      const t = rr.text.out >= 3 ? Math.round((rr.text.in / rr.text.out) * 100) : 0;
      return Math.max(e, t);
    };

    // Compute referral source profile
    const sources = contacts.filter((c) => (referralGciMap[c.id] ?? 0) > 0);
    if (sources.length < 3) {
      return NextResponse.json({ profile_size: sources.length, top_potential: [] });
    }

    const catCounts: Record<string, number> = {};
    const tierCounts: Record<string, number> = {};
    let linkedinCount = 0;
    let totalReplyRate = 0;
    let replyRateN = 0;

    for (const s of sources) {
      catCounts[(s.category || "other").toLowerCase()] = (catCounts[(s.category || "other").toLowerCase()] ?? 0) + 1;
      tierCounts[(s.tier || "none").toUpperCase()] = (tierCounts[(s.tier || "none").toUpperCase()] ?? 0) + 1;
      if (s.linkedin_connected_at) linkedinCount++;
      const r = bestReplyRate(s.id);
      if (r > 0) { totalReplyRate += r; replyRateN++; }
    }

    const n = sources.length;
    const catWeights: Record<string, number> = Object.fromEntries(Object.entries(catCounts).map(([k, v]) => [k, (v as number) / n]));
    const tierWeights: Record<string, number> = Object.fromEntries(Object.entries(tierCounts).map(([k, v]) => [k, (v as number) / n]));
    const linkedinRate = linkedinCount / n;
    const avgReplyRate = replyRateN > 0 ? totalReplyRate / replyRateN : 0;

    // Score non-source contacts
    const scored = contacts
      .filter((c) => (referralGciMap[c.id] ?? 0) === 0)
      .map((c) => {
        const cat = (c.category || "other").toLowerCase();
        const tier = (c.tier || "none").toUpperCase();
        const rate = bestReplyRate(c.id);
        const daysSince = c.last_contact_at
          ? Math.floor((nowMs - new Date(c.last_contact_at).getTime()) / 86400000)
          : null;

        let score = 0;
        const reasons: string[] = [];

        const catScore = Math.round((catWeights[cat] ?? 0) * 30);
        if (catScore >= 15) { score += catScore; reasons.push(cat.charAt(0).toUpperCase() + cat.slice(1)); }

        const tierScore = Math.round((tierWeights[tier] ?? 0) * 20);
        if (tierScore >= 10) { score += tierScore; reasons.push(`Tier ${tier}`); }

        if (c.linkedin_connected_at && linkedinRate >= 0.3) { score += 10; reasons.push("LinkedIn connection"); }

        if (rate >= avgReplyRate && rate > 0) { score += 15; reasons.push("High response rate"); }
        else if (rate > 0) score += 7;

        if (tier === "A") score += 10;
        else if (tier === "B") score += 5;

        return {
          id: c.id,
          display_name: c.display_name,
          category: c.category,
          tier: c.tier,
          referral_potential: Math.min(100, score),
          match_reasons: reasons,
          days_since_contact: daysSince,
        };
      })
      .filter((c) => c.referral_potential >= 50)
      .sort((a, b) => b.referral_potential - a.referral_potential)
      .slice(0, 10);

    return NextResponse.json({ profile_size: sources.length, top_potential: scored });
  } catch (e) {
    return serverError("REFERRAL_POTENTIAL_CRASH", e);
  }
}
