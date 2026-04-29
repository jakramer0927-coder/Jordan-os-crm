import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUser, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

const TIER_CADENCE: Record<string, number> = { A: 30, B: 60, C: 90, D: 150 };

export async function POST(req: Request) {
  try {
    const user = await getVerifiedUser();
    if (!user) return unauthorized();
    const uid = user.id;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "Missing ANTHROPIC_API_KEY" }, { status: 500 });
    const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

    const now = new Date();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString();
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();

    // Gather all data in parallel
    const [
      contactsRes,
      touchesThisRes,
      touchesPriorRes,
      referralOutcomesRes,
      activeDealsRes,
      closedDealsRes,
      referralSourcesRes,
    ] = await Promise.all([
      supabaseAdmin
        .from("contacts")
        .select("id, category, tier, last_contact_at, created_at")
        .eq("user_id", uid)
        .eq("archived", false),

      supabaseAdmin
        .from("touches")
        .select("contact_id, channel, intent")
        .eq("user_id", uid)
        .eq("direction", "outbound")
        .gte("occurred_at", thirtyDaysAgo),

      supabaseAdmin
        .from("touches")
        .select("contact_id, channel, intent")
        .eq("user_id", uid)
        .eq("direction", "outbound")
        .gte("occurred_at", sixtyDaysAgo)
        .lt("occurred_at", thirtyDaysAgo),

      supabaseAdmin
        .from("touches")
        .select("outcome, occurred_at")
        .eq("user_id", uid)
        .eq("intent", "referral_ask")
        .gte("occurred_at", ninetyDaysAgo),

      supabaseAdmin
        .from("deals")
        .select("status, price, deal_type")
        .eq("user_id", uid)
        .not("status", "in", '("closed_won","closed_lost")'),

      supabaseAdmin
        .from("deals")
        .select("price, close_date, deal_type")
        .eq("user_id", uid)
        .eq("status", "closed_won")
        .gte("close_date", thirtyDaysAgo),

      supabaseAdmin
        .from("deals")
        .select("referral_source_contact_id, price, contacts!inner(display_name, category, tier, last_contact_at)")
        .eq("user_id", uid)
        .eq("status", "closed_won")
        .not("referral_source_contact_id", "is", null),
    ]);

    const contacts = contactsRes.data ?? [];
    const touchesThis = touchesThisRes.data ?? [];
    const touchesPrior = touchesPriorRes.data ?? [];
    const referralOutcomes = referralOutcomesRes.data ?? [];
    const activeDeals = activeDealsRes.data ?? [];
    const closedDeals = closedDealsRes.data ?? [];
    const referralSourceDeals = referralSourcesRes.data ?? [];

    // -- Contact health --
    const catCounts: Record<string, number> = {};
    const tierCounts: Record<string, number> = {};
    const overdueByTier: Record<string, number> = {};
    let neverTouched = 0;

    for (const c of contacts) {
      const cat = (c.category || "other").toLowerCase();
      const tier = (c.tier || "none").toUpperCase();
      catCounts[cat] = (catCounts[cat] ?? 0) + 1;
      tierCounts[tier] = (tierCounts[tier] ?? 0) + 1;

      if (!c.last_contact_at) { neverTouched++; continue; }
      const daysSince = Math.floor((Date.now() - new Date(c.last_contact_at).getTime()) / 86400000);
      const cadence = TIER_CADENCE[tier] ?? 90;
      if (daysSince > cadence) {
        overdueByTier[tier] = (overdueByTier[tier] ?? 0) + 1;
      }
    }

    // -- Touch activity --
    const channelThis: Record<string, number> = {};
    const intentThis: Record<string, number> = {};
    const uniqueContactsThis = new Set<string>();
    for (const t of touchesThis) {
      channelThis[t.channel] = (channelThis[t.channel] ?? 0) + 1;
      intentThis[t.intent ?? "other"] = (intentThis[t.intent ?? "other"] ?? 0) + 1;
      if (t.contact_id) uniqueContactsThis.add(t.contact_id);
    }
    const uniqueContactsPrior = new Set(touchesPrior.map((t: any) => t.contact_id).filter(Boolean));

    // -- Referral performance --
    const referralAsksTotal = referralOutcomes.length;
    const referralGot = referralOutcomes.filter((r: any) => r.outcome === "referred").length;
    const referralNo = referralOutcomes.filter((r: any) => r.outcome === "no_referral").length;
    const referralPending = referralOutcomes.filter((r: any) => r.outcome === "pending").length;

    // -- Pipeline --
    const dealsByStatus: Record<string, number> = {};
    let activePipelineValue = 0;
    for (const d of activeDeals) {
      dealsByStatus[d.status] = (dealsByStatus[d.status] ?? 0) + 1;
      activePipelineValue += d.price ?? 0;
    }
    const closedThisPeriodValue = closedDeals.reduce((sum: number, d: any) => sum + (d.price ?? 0), 0);

    // -- Top referral sources --
    const sourceMap: Record<string, { name: string; gci: number; category: string; tier: string; last_contact_at: string | null }> = {};
    for (const d of referralSourceDeals as any[]) {
      const id = d.referral_source_contact_id;
      if (!id) continue;
      const c = d.contacts;
      if (!sourceMap[id]) {
        sourceMap[id] = {
          name: c?.display_name ?? "Unknown",
          gci: 0,
          category: c?.category ?? "",
          tier: c?.tier ?? "",
          last_contact_at: c?.last_contact_at ?? null,
        };
      }
      sourceMap[id].gci += d.price ?? 0;
    }
    const topSources = Object.values(sourceMap)
      .sort((a, b) => b.gci - a.gci)
      .slice(0, 8)
      .map((s) => {
        const daysSince = s.last_contact_at
          ? Math.floor((Date.now() - new Date(s.last_contact_at).getTime()) / 86400000)
          : null;
        const tier = s.tier?.toUpperCase();
        const cadence = TIER_CADENCE[tier ?? ""] ?? 90;
        const overdue = daysSince !== null && daysSince > cadence;
        return { ...s, days_since_contact: daysSince, overdue, gci_formatted: `$${Math.round(s.gci / 1000)}k` };
      });

    const overdueTopSources = topSources.filter((s) => s.overdue);

    // Build data summary for Claude
    const dataSnapshot = {
      period: `${now.toLocaleString("default", { month: "long" })} ${now.getFullYear()}`,
      contacts: {
        total: contacts.length,
        by_category: catCounts,
        by_tier: tierCounts,
        never_touched: neverTouched,
        overdue_by_tier: overdueByTier,
      },
      touches: {
        this_period: touchesThis.length,
        prior_period: touchesPrior.length,
        delta: touchesThis.length - touchesPrior.length,
        unique_contacts: uniqueContactsThis.size,
        unique_contacts_prior: uniqueContactsPrior.size,
        by_channel: channelThis,
        by_intent: intentThis,
      },
      referrals: {
        asks_last_90d: referralAsksTotal,
        got_referral: referralGot,
        no_outcome: referralNo,
        still_pending: referralPending,
        conversion_rate: referralAsksTotal > 0 ? Math.round((referralGot / referralAsksTotal) * 100) : null,
      },
      pipeline: {
        active_deals: activeDeals.length,
        active_pipeline_value: activePipelineValue,
        by_status: dealsByStatus,
        closed_this_period: closedDeals.length,
        closed_value_this_period: closedThisPeriodValue,
      },
      referral_network: {
        top_sources: topSources,
        overdue_top_sources: overdueTopSources.length,
      },
    };

    const periodLabel = `${now.toLocaleString("default", { month: "long" })} ${now.getFullYear()}`;

    const systemPrompt = `You are a sharp, direct business advisor writing a monthly intelligence report for Jordan Kramer — luxury real estate agent at Compass, Los Angeles. Jordan closes ~20 transactions/year, 85% referral-driven, targets $25M GCI. His clients are tech/finance/entertainment professionals. He operates as a consultant: analytical, honest, zero-fluff.

Write a monthly CRM intelligence report. Format it exactly as markdown with these sections:

## ${periodLabel} — Intelligence Report

[2-3 sentence executive summary in second person. Lead with the single most important thing he should know from this data.]

## What's Working
[3 specific bullets grounded in the numbers. Use actual figures. No generic advice.]

## Where to Focus
[3-4 bullets each with a concrete, specific action tied to the data. Name names or categories. Tell him exactly what to do differently.]

## Referral Network
[Paragraph analyzing referral source health. Call out specifically which overdue top sources need attention by name if available. Give a referral conversion rate verdict.]

## Pipeline
[Paragraph on deal flow. Note active deal count, value, and what needs attention this month.]

## Top 5 Contacts to Prioritize
[Five specific contacts from the data — prioritize overdue top referral sources, then high-tier overdue contacts. For each: name, why they matter, one-sentence suggested approach. Format as numbered list.]

## One Strategic Observation
[One non-obvious insight from the data that he probably hasn't noticed. Be specific. This is the most valuable paragraph — make it count.]

Tone: direct, analytical, no hedging. Write for someone who will act on this immediately. No filler phrases like "it's important to" or "consider reaching out." Use exact numbers from the data.`;

    const userContent = `Here is the CRM data for the report:\n\n${JSON.stringify(dataSnapshot, null, 2)}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    const j = await res.json();
    if (!res.ok) throw new Error(j?.error?.message || `Anthropic error (${res.status})`);

    const content = j?.content?.[0]?.text?.trim() ?? "";

    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const periodEnd = now.toISOString().slice(0, 10);

    await supabaseAdmin.from("reports").insert({
      user_id: uid,
      period_label: periodLabel,
      period_start: periodStart,
      period_end: periodEnd,
      content,
      data_snapshot: dataSnapshot,
    });

    return NextResponse.json({ report: content, period: periodLabel, snapshot: dataSnapshot });
  } catch (e) {
    return serverError("REPORT_GENERATE_CRASH", e);
  }
}
