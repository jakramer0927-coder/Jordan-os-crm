import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

const DISPLAY_CHANNELS = ["email", "text", "call", "in_person"];
const DISPLAY_CATEGORIES = ["agent", "client", "sphere", "developer", "vendor"];

function weekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

function buildCoaching(data: {
  channelRates: Record<string, { out: number; inbound: number }>;
  catTouches: Record<string, number>;
  catTouchesPrior: Record<string, number>;
  intentCounts: Record<string, number>;
  referralOutcomes: { referred: number; total: number };
  totalThis: number;
  totalPrior: number;
  weeklyTrend: { week: string; count: number }[];
}): string[] {
  const tips: string[] = [];

  const { channelRates, catTouches, catTouchesPrior, intentCounts, referralOutcomes, totalThis, totalPrior, weeklyTrend } = data;

  // Channel comparison
  const emailRate = channelRates.email?.out >= 5
    ? Math.round((channelRates.email.inbound / channelRates.email.out) * 100) : null;
  const textRate = channelRates.text?.out >= 5
    ? Math.round((channelRates.text.inbound / channelRates.text.out) * 100) : null;

  if (emailRate !== null && textRate !== null) {
    if (textRate > emailRate + 15) {
      tips.push(`Text gets ${textRate}% reply rate vs ${emailRate}% for email — default to text for sphere and client check-ins.`);
    } else if (emailRate > textRate + 15) {
      tips.push(`Email gets ${emailRate}% reply rate vs ${textRate}% for text — your network responds better to email.`);
    }
  } else if (textRate !== null && emailRate === null) {
    tips.push(`Text is your best-tracked channel at ${textRate}% reply rate — keep leaning on it.`);
  }

  // Volume trend
  if (totalPrior > 0) {
    const delta = totalThis - totalPrior;
    const pct = Math.round((delta / totalPrior) * 100);
    if (pct <= -25) {
      tips.push(`Touch volume dropped ${Math.abs(pct)}% vs last period — ${totalThis} touches vs ${totalPrior}. Protect your outreach time.`);
    } else if (pct >= 25) {
      tips.push(`Touch volume up ${pct}% vs last period (${totalThis} vs ${totalPrior}) — strong momentum, keep it consistent.`);
    }
  }

  // Agent cadence
  const agentThis = catTouches.agent ?? 0;
  const agentPrior = catTouchesPrior.agent ?? 0;
  if (agentPrior > 0 && agentThis < agentPrior * 0.6) {
    tips.push(`Agent touches dropped from ${agentPrior} to ${agentThis} — agents are your highest co-op and referral channel, don't let them slip.`);
  } else if (agentThis === 0) {
    tips.push(`No agent touches this period — agents are a high-value co-op and referral source. Add 2-3 to your weekly routine.`);
  }

  // Sphere vs client balance
  const sphereThis = catTouches.sphere ?? 0;
  const clientThis = catTouches.client ?? 0;
  if (sphereThis > 0 && clientThis > 0) {
    const sphereShare = sphereThis / (sphereThis + clientThis);
    if (sphereShare < 0.25 && sphereThis < 5) {
      tips.push(`Only ${sphereThis} sphere touches this period — sphere is your #1 referral source at 85%. Increase sphere cadence.`);
    }
  }

  // Referral ask conversion
  if (referralOutcomes.total >= 5) {
    const rate = Math.round((referralOutcomes.referred / referralOutcomes.total) * 100);
    if (rate < 10) {
      tips.push(`Referral ask conversion: ${rate}% (${referralOutcomes.referred}/${referralOutcomes.total}). Ask after a genuine check-in, not cold — warm the relationship first.`);
    } else if (rate >= 20) {
      tips.push(`Referral ask conversion: ${rate}% — above average. Keep asking; your approach is working.`);
    }
  } else if ((intentCounts.referral_ask ?? 0) < 3) {
    tips.push(`Only ${intentCounts.referral_ask ?? 0} referral asks logged — at 85% referral-driven, you should be making 5+ asks per week.`);
  }

  // Consistency check
  if (weeklyTrend.length >= 8) {
    const counts = weeklyTrend.slice(-8).map((w) => w.count);
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    const maxDev = Math.max(...counts.map((c) => Math.abs(c - avg)));
    if (avg > 2 && maxDev > avg * 0.8) {
      tips.push(`High weekly variance in touches — consistent daily outreach outperforms sporadic high-volume days. Aim for ${Math.max(3, Math.round(avg))} touches every weekday.`);
    }
  }

  return tips.slice(0, 5);
}

export async function GET(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
    const oneEightyDaysAgo = new Date(Date.now() - 180 * 86400000).toISOString();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString();

    const [touchesRes, contactCategoryRes, referralOutcomesRes] = await Promise.all([
      supabaseAdmin
        .from("touches")
        .select("contact_id, channel, direction, intent, occurred_at")
        .eq("user_id", uid)
        .gte("occurred_at", oneEightyDaysAgo),

      supabaseAdmin
        .from("contacts")
        .select("id, category")
        .eq("user_id", uid)
        .eq("archived", false),

      supabaseAdmin
        .from("touches")
        .select("outcome")
        .eq("user_id", uid)
        .eq("intent", "referral_ask")
        .gte("occurred_at", ninetyDaysAgo),
    ]);

    const allTouches = touchesRes.data ?? [];
    const contacts = contactCategoryRes.data ?? [];
    const catMap: Record<string, string> = {};
    for (const c of contacts) catMap[c.id] = (c.category || "other").toLowerCase();

    // Split into this period (last 90d) and prior period (90-180d)
    const touchesThis = allTouches.filter((t) => t.occurred_at >= ninetyDaysAgo);
    const touchesPrior = allTouches.filter((t) => t.occurred_at < ninetyDaysAgo);

    // Channel reply rates (this period)
    const channelRates: Record<string, { out: number; inbound: number }> = {};
    for (const t of touchesThis) {
      const ch = t.channel || "other";
      if (!channelRates[ch]) channelRates[ch] = { out: 0, inbound: 0 };
      if (t.direction === "outbound") channelRates[ch].out++;
      else if (t.direction === "inbound") channelRates[ch].inbound++;
    }

    // Category touches this vs prior period (last 30 vs 30-60 days for tight comparison)
    const catTouches: Record<string, number> = {};
    const catTouchesPrior: Record<string, number> = {};
    const catReplyRates: Record<string, { out: number; inbound: number }> = {};

    for (const t of allTouches) {
      const cat = catMap[t.contact_id] ?? "other";
      if (t.occurred_at >= thirtyDaysAgo) {
        if (t.direction === "outbound") catTouches[cat] = (catTouches[cat] ?? 0) + 1;
      } else if (t.occurred_at >= sixtyDaysAgo) {
        if (t.direction === "outbound") catTouchesPrior[cat] = (catTouchesPrior[cat] ?? 0) + 1;
      }
      // Reply rates by category (all 90 days)
      if (t.occurred_at >= ninetyDaysAgo) {
        if (!catReplyRates[cat]) catReplyRates[cat] = { out: 0, inbound: 0 };
        if (t.direction === "outbound") catReplyRates[cat].out++;
        else if (t.direction === "inbound") catReplyRates[cat].inbound++;
      }
    }

    // Intent breakdown (this period outbound)
    const intentCounts: Record<string, number> = {};
    for (const t of touchesThis) {
      if (t.direction === "outbound" && t.intent) {
        intentCounts[t.intent] = (intentCounts[t.intent] ?? 0) + 1;
      }
    }

    // Weekly trend (last 13 weeks)
    const weekMap: Record<string, number> = {};
    const thirteenWeeksAgo = new Date(Date.now() - 91 * 86400000).toISOString();
    for (const t of allTouches) {
      if (t.direction === "outbound" && t.occurred_at >= thirteenWeeksAgo) {
        const w = weekStart(new Date(t.occurred_at));
        weekMap[w] = (weekMap[w] ?? 0) + 1;
      }
    }
    const weeklyTrend = Object.entries(weekMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, count]) => ({ week, count }));

    // Referral outcomes
    const refOutcomes = referralOutcomesRes.data ?? [];
    const referralOutcomes = {
      total: refOutcomes.length,
      referred: refOutcomes.filter((r: any) => r.outcome === "referred").length,
      no_referral: refOutcomes.filter((r: any) => r.outcome === "no_referral").length,
      pending: refOutcomes.filter((r: any) => r.outcome === "pending").length,
    };

    // Format channel stats
    const channelStats = DISPLAY_CHANNELS
      .filter((ch) => channelRates[ch])
      .map((ch) => {
        const { out, inbound } = channelRates[ch];
        return {
          channel: ch,
          outbound: out,
          inbound,
          reply_rate: out >= 3 ? Math.round((inbound / out) * 100) : null,
        };
      });

    // Format category stats
    const categoryStats = DISPLAY_CATEGORIES
      .filter((cat) => (catTouches[cat] ?? 0) > 0 || (catReplyRates[cat]?.out ?? 0) > 0)
      .map((cat) => {
        const rr = catReplyRates[cat];
        return {
          category: cat,
          touches_this: catTouches[cat] ?? 0,
          touches_prior: catTouchesPrior[cat] ?? 0,
          reply_rate: rr && rr.out >= 3 ? Math.round((rr.inbound / rr.out) * 100) : null,
        };
      });

    const totalThis = touchesThis.filter((t) => t.direction === "outbound").length;
    const totalPrior = touchesPrior
      .filter((t) => t.occurred_at >= sixtyDaysAgo && t.occurred_at < thirtyDaysAgo && t.direction === "outbound")
      .length;

    const coaching = buildCoaching({
      channelRates,
      catTouches,
      catTouchesPrior,
      intentCounts,
      referralOutcomes,
      totalThis,
      totalPrior,
      weeklyTrend,
    });

    return NextResponse.json({
      period_days: 90,
      total_outbound: totalThis,
      total_outbound_prior: totalPrior,
      channel_stats: channelStats,
      category_stats: categoryStats,
      intent_counts: intentCounts,
      referral_outcomes: referralOutcomes,
      weekly_trend: weeklyTrend,
      coaching,
    });
  } catch (e) {
    return serverError("VOICE_PATTERNS_CRASH", e);
  }
}
