"use client";

import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

// ── Types ─────────────────────────────────────────────────────────────────────

type Touch = {
  id: string;
  contact_id: string;
  direction: "outbound" | "inbound";
  occurred_at: string;
  intent: string | null;
};

type Contact = {
  id: string;
  display_name: string;
  category: string;
  tier: string | null;
  created_at: string;
};

type Deal = {
  id: string;
  contact_id: string;
  opp_type: string;
  pipeline_status: string;
  price: number | null;
  list_price: number | null;
  estimated_value: number | null;
  budget_min: number | null;
  budget_max: number | null;
  commission_pct: number | null;
  close_date: string | null;
  created_at: string;
  neighborhood: string | null;
  address: string | null;
  referral_source: { id: string; display_name: string; category: string | null } | null;
};

type WeekSummary = {
  label: string;
  weekStart: Date;
  outbound: number;
  agents: number;
  refAsks: number;
  daysGoal: number;
  days: Array<{ dateStr: string; count: number; isToday: boolean; isFuture: boolean }>;
};

type AvoidedContact = {
  id: string;
  display_name: string;
  category: string;
  tier: string | null;
  days: number | null;
  cadence: number;
  overdueBy: number;
};

type CatCompliance = { total: number; onCadence: number };

type RefSourceRow = {
  contact_id: string;
  display_name: string;
  category: string | null;
  deals_total: number;
  deals_closed: number;
  pipeline_value: number;
  closed_value: number;
  closed_gci: number;
  pipeline_gci: number;
};

type RefAskOpportunity = {
  id: string;
  display_name: string;
  category: string;
  tier: string | null;
  daysSinceLastAsk: number | null;
  daysSinceOutbound: number | null;
  closedDeals: number;
  score: number;
  reason: string;
};

type Timeframe = "quarter" | "ytd" | "trailing12" | "trailing24" | "all";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadDailyGoal(uid: string): Promise<number> {
  try {
    const { data } = await supabase
      .from("user_settings")
      .select("value")
      .eq("user_id", uid)
      .eq("key", "morning_rules")
      .maybeSingle();
    return (data?.value as { totalRecs?: number } | null)?.totalRecs ?? 5;
  } catch { return 5; }
}

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isWeekendDay(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

function startOfWeekMonday(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function weekdaysElapsed(now = new Date()): number {
  const day = now.getDay();
  if (day === 0 || day === 6) return 5;
  return day;
}

function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

function cadenceDays(category: string, tier: string | null): number {
  const cat = (category || "").toLowerCase();
  const t = (tier || "").toUpperCase();
  if (cat === "client") return t === "A" ? 30 : t === "B" ? 60 : 90;
  if (cat === "agent") return t === "A" ? 30 : t === "B" ? 60 : 90;
  if (cat === "developer") return 60;
  if (cat === "sphere") return t === "A" ? 30 : t === "B" ? 60 : 90;
  return t === "A" ? 45 : t === "B" ? 75 : 120;
}

function deltaPct(curr: number, prev: number): number {
  if (prev <= 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function fmt$(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n.toLocaleString()}`;
}

// LA zip → neighborhood for generic "Los Angeles" addresses
const LA_ZIP_NEIGHBORHOODS: Record<string, string> = {
  "90004": "Koreatown", "90005": "Koreatown", "90006": "Koreatown",
  "90012": "Downtown LA", "90013": "Downtown LA", "90014": "Downtown LA", "90015": "Downtown LA",
  "90016": "West Adams", "90017": "Westlake",
  "90019": "Mid-City", "90020": "Hancock Park", "90024": "Westwood",
  "90025": "West LA", "90026": "Silver Lake", "90027": "Los Feliz",
  "90028": "Hollywood", "90029": "East Hollywood", "90031": "Lincoln Heights",
  "90032": "El Sereno", "90034": "Palms", "90035": "Beverlywood",
  "90036": "Fairfax", "90038": "Hollywood", "90039": "Atwater Village",
  "90041": "Eagle Rock", "90042": "Highland Park", "90043": "Leimert Park",
  "90044": "South LA", "90045": "Westchester", "90046": "West Hollywood Hills",
  "90047": "South LA", "90048": "West Hollywood", "90049": "Brentwood",
  "90056": "Ladera Heights", "90057": "Westlake", "90058": "Vernon",
  "90061": "South LA", "90062": "South LA", "90063": "East LA",
  "90064": "Rancho Park", "90065": "Mt Washington", "90066": "Mar Vista",
  "90067": "Century City", "90068": "Hollywood Hills", "90069": "West Hollywood",
  "90071": "Downtown LA", "90073": "Brentwood", "90077": "Bel Air",
  "90094": "Playa Vista", "90210": "Beverly Hills", "90211": "Beverly Hills",
  "90212": "Beverly Hills", "90230": "Culver City", "90232": "Culver City",
  "90245": "El Segundo", "90272": "Pacific Palisades", "90290": "Topanga",
  "90291": "Venice", "90292": "Marina del Rey", "90293": "Playa del Rey",
  "90401": "Santa Monica", "90402": "Santa Monica", "90403": "Santa Monica",
  "90404": "Santa Monica", "90405": "Santa Monica",
};

function parseNeighborhoodFromAddress(address: string | null): string | null {
  if (!address) return null;
  const parts = address.split(",").map(s => s.trim());
  if (parts.length < 2) return null;
  // parts[1] is usually the city/neighborhood
  const city = parts[1];
  if (!city || city === "USA") return null;
  // If it's a named district (not generic "Los Angeles"), use it directly
  if (city !== "Los Angeles") return city;
  // For generic LA, try zip-based lookup
  const zipMatch = address.match(/\b(\d{5})\b/);
  if (zipMatch) return LA_ZIP_NEIGHBORHOODS[zipMatch[1]] ?? "Los Angeles";
  return "Los Angeles";
}

function dealGci(d: Deal): number {
  const price = d.price ?? 0;
  const pct = d.commission_pct ?? 2.5;
  return price * pct / 100;
}

function dealProjectedValue(d: Deal): number {
  if (d.opp_type === "seller") return d.list_price ?? d.estimated_value ?? d.price ?? 0;
  return d.budget_max ?? d.price ?? 0;
}

function timeframeCutoff(tf: Timeframe): Date | null {
  const now = new Date();
  if (tf === "all") return null;
  if (tf === "ytd") return new Date(now.getFullYear(), 0, 1);
  if (tf === "quarter") { const d = new Date(now); d.setMonth(d.getMonth() - 3); return d; }
  if (tf === "trailing12") { const d = new Date(now); d.setFullYear(d.getFullYear() - 1); return d; }
  if (tf === "trailing24") { const d = new Date(now); d.setFullYear(d.getFullYear() - 2); return d; }
  return null;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function InsightsPage() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const [dailyGoal, setDailyGoal] = useState(5);
  const [timeframe, setTimeframe] = useState<Timeframe>("ytd");
  const TF_LABELS: Record<Timeframe, string> = {
    quarter: "Quarter", ytd: "YTD", trailing12: "Last 12 Months", trailing24: "Last 2 Years", all: "All Time",
  };

  // Accountability state
  const [out7, setOut7] = useState(0);
  const [out7Prev, setOut7Prev] = useState(0);
  const [out30, setOut30] = useState(0);
  const [agents7, setAgents7] = useState(0);
  const [refAsks30, setRefAsks30] = useState(0);
  const [wtdOutbound, setWtdOutbound] = useState(0);
  const [wtdAgents, setWtdAgents] = useState(0);
  const [wtdReferralAsks, setWtdReferralAsks] = useState(0);
  const [todayCount, setTodayCount] = useState(0);
  const [streak, setStreak] = useState(0);
  const [weeklyHistory, setWeeklyHistory] = useState<WeekSummary[]>([]);
  const [avoidedContacts, setAvoidedContacts] = useState<AvoidedContact[]>([]);
  const [slippingOpen, setSlippingOpen] = useState(false);
  const [catCompliance, setCatCompliance] = useState<Record<string, CatCompliance>>({});
  const [refOpportunities, setRefOpportunities] = useState<RefAskOpportunity[]>([]);
  const [loggingAsk, setLoggingAsk] = useState<string | null>(null);
  const [loggedAskIds, setLoggedAskIds] = useState<Set<string>>(new Set());
  const [refPotential, setRefPotential] = useState<{ profile_size: number; top_potential: Array<{ id: string; display_name: string; category: string; tier: string; referral_potential: number; match_reasons: string[]; days_since_contact: number | null }> } | null>(null);
  const [commPatterns, setCommPatterns] = useState<{
    total_outbound: number;
    total_outbound_prior: number;
    channel_stats: Array<{ channel: string; outbound: number; inbound: number; reply_rate: number | null }>;
    category_stats: Array<{ category: string; touches_this: number; touches_prior: number; reply_rate: number | null }>;
    intent_counts: Record<string, number>;
    referral_outcomes: { total: number; referred: number; no_referral: number; pending: number };
    weekly_trend: Array<{ week: string; count: number }>;
    coaching: string[];
  } | null>(null);
  // refSources is derived via useMemo below (timeframe-aware)
  const [contactsTotal, setContactsTotal] = useState(0);
  const [aClientsTotal, setAClientsTotal] = useState(0);
  const [aClientsDueOrOverdue, setAClientsDueOrOverdue] = useState(0);
  const [aClientsVeryOverdue, setAClientsVeryOverdue] = useState(0);
  const [allContacts, setAllContacts] = useState<Contact[]>([]);

  // Business intelligence state
  const [allDeals, setAllDeals] = useState<Deal[]>([]);
  const [aiBrief, setAiBrief] = useState<string | null>(null);
  const [aiBriefLoading, setAiBriefLoading] = useState(false);

  const wow = useMemo(() => deltaPct(out7, out7Prev), [out7, out7Prev]);
  const wdElapsed = useMemo(() => weekdaysElapsed(), [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const wtdPace = useMemo(() => wdElapsed * dailyGoal, [wdElapsed, dailyGoal]);
  const isOnPace = useMemo(() => wtdOutbound >= wtdPace * 0.8, [wtdOutbound, wtdPace]);
  const wtdDeficit = useMemo(() => Math.max(0, wtdPace - wtdOutbound), [wtdPace, wtdOutbound]);

  const health = useMemo(() => {
    const aComp = aClientsTotal > 0
      ? clamp(Math.round(30 * (1 - aClientsDueOrOverdue / aClientsTotal)), 0, 30) : 30;
    const velocity = clamp(Math.round((out30 / (dailyGoal * 20)) * 25), 0, 25);
    const agentShare = out7 > 0 ? agents7 / out7 : 0;
    const agent = clamp(Math.round((agentShare / 0.4) * 20), 0, 20);
    const ask = clamp(Math.round((refAsks30 / 4) * 15), 0, 15);
    const growth = clamp(Math.round((contactsTotal / 200) * 10), 0, 10);
    return { total: aComp + velocity + agent + ask + growth };
  }, [aClientsTotal, aClientsDueOrOverdue, out30, dailyGoal, out7, agents7, refAsks30, contactsTotal]);

  // ── Business metrics (timeframe-filtered) ────────────────────────────────────
  const bizMetrics = useMemo(() => {
    const cutoff = timeframeCutoff(timeframe);

    // Closed deals: filter by close_date; fall back to created_at if close_date missing
    const closed = allDeals.filter(d => {
      if (d.pipeline_status !== "past_client") return false;
      if (!cutoff) return true;
      const dateStr = d.close_date || d.created_at;
      return new Date(dateStr) >= cutoff;
    });
    // Active deals are current pipeline — not timeframe-filtered
    const active = allDeals.filter(d => d.pipeline_status === "active");
    // For source breakdown, use closed deals in timeframe + active pipeline
    const filtered = [...closed, ...active];

    const closedGci = closed.reduce((sum, d) => sum + dealGci(d), 0);
    const projectedGci = active.reduce((sum, d) => {
      const val = dealProjectedValue(d);
      return sum + val * ((d.commission_pct ?? 2.5) / 100);
    }, 0);
    const closedCount = closed.length;
    const activeCount = active.length;

    const buyers = closed.filter(d => d.opp_type === "buyer").length;
    const sellers = closed.filter(d => d.opp_type === "seller").length;

    const avgClosePrice = closed.length > 0
      ? closed.reduce((s, d) => s + (d.price ?? 0), 0) / closed.length
      : 0;

    // Price buckets (closed deals)
    const priceBuckets: Record<string, number> = { "<$2M": 0, "$2–5M": 0, "$5–10M": 0, "$10M+": 0 };
    for (const d of closed) {
      const p = d.price ?? 0;
      if (p < 2_000_000) priceBuckets["<$2M"]++;
      else if (p < 5_000_000) priceBuckets["$2–5M"]++;
      else if (p < 10_000_000) priceBuckets["$5–10M"]++;
      else priceBuckets["$10M+"]++;
    }

    // Geographic distribution (all active + closed deals)
    const neighborhoodMap = new Map<string, { count: number; gci: number }>();
    for (const d of [...active, ...closed]) {
      // Use DB neighborhood if set; otherwise parse city from address string
      // Address format from Google Places: "123 Main St, Sherman Oaks, CA 91423, USA"
      const n = d.neighborhood?.trim() || parseNeighborhoodFromAddress(d.address) || null;
      if (!n) continue;
      const existing = neighborhoodMap.get(n) ?? { count: 0, gci: 0 };
      existing.count++;
      existing.gci += dealGci(d);
      neighborhoodMap.set(n, existing);
    }
    const neighborhoods = [...neighborhoodMap.entries()]
      .map(([name, v]) => ({ name, count: v.count, gci: v.gci }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Business source breakdown (filtered deals)
    const sourceByCategory: Record<string, { count: number; gci: number }> = {};
    let noSource = 0;
    for (const d of filtered) {
      const cat = (d.referral_source?.category || "").toLowerCase() || null;
      const gci = dealGci(d);
      if (!cat) { noSource++; continue; }
      const key = cat === "agent" ? "Agent" : cat === "client" ? "Client" : cat === "sphere" ? "Sphere" : cat === "developer" ? "Developer" : "Other";
      const existing = sourceByCategory[key] ?? { count: 0, gci: 0 };
      existing.count++;
      existing.gci += gci;
      sourceByCategory[key] = existing;
    }
    const totalSourced = Object.values(sourceByCategory).reduce((s, v) => s + v.count, 0);

    // Contact composition
    const catCounts: Record<string, number> = {};
    for (const c of allContacts) {
      const cat = (c.category || "other").toLowerCase();
      catCounts[cat] = (catCounts[cat] ?? 0) + 1;
    }

    // Developer contacts
    const developerCount = catCounts["developer"] ?? 0;

    // Contact growth by month (last 12 months)
    const now = new Date();
    const growthByMonth: { label: string; count: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
      const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
      const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      const count = allContacts.filter(c => {
        const ca = new Date(c.created_at);
        return ca >= monthStart && ca < monthEnd;
      }).length;
      growthByMonth.push({ label, count });
    }

    return {
      closedGci, projectedGci, closedCount, activeCount,
      buyers, sellers, avgClosePrice,
      priceBuckets, neighborhoods,
      sourceByCategory, totalSourced, noSource,
      catCounts, developerCount, growthByMonth,
    };
  }, [allDeals, allContacts, timeframe]);

  // ── Top referral sources — timeframe-filtered ────────────────────────────────
  const refSources = useMemo(() => {
    const cutoff = timeframeCutoff(timeframe);
    const sourceMap = new Map<string, RefSourceRow>();
    for (const d of allDeals) {
      const src = d.referral_source as any;
      if (!src?.id) continue;
      const isPastClient = d.pipeline_status === "past_client";
      if (isPastClient && cutoff) {
        const dateStr = d.close_date || d.created_at;
        if (new Date(dateStr) < cutoff) continue;
      }
      const existing = sourceMap.get(src.id) ?? {
        contact_id: src.id, display_name: src.display_name, category: src.category ?? null,
        deals_total: 0, deals_closed: 0, pipeline_value: 0, closed_value: 0,
        closed_gci: 0, pipeline_gci: 0,
      };
      existing.deals_total++;
      const gci = dealGci(d);
      if (isPastClient) {
        existing.deals_closed++;
        existing.closed_value += d.price ?? 0;
        existing.closed_gci += gci;
      } else {
        existing.pipeline_value += dealProjectedValue(d);
        existing.pipeline_gci += gci;
      }
      sourceMap.set(src.id, existing);
    }
    return [...sourceMap.values()].sort((a, b) => (b.closed_gci + b.pipeline_gci) - (a.closed_gci + a.pipeline_gci));
  }, [allDeals, timeframe]);

  // ── Quick insights (accountability-focused, no day-gating) ───────────────────
  const quickInsights = useMemo(() => {
    const items: Array<{ text: string; rec: string; urgent: boolean }> = [];

    if (aClientsVeryOverdue > 0) {
      items.push({
        text: `${aClientsVeryOverdue} A-client${aClientsVeryOverdue !== 1 ? "s are" : " is"} 14+ days past cadence`,
        rec: "Open Morning page and prioritize these contacts today",
        urgent: true,
      });
    }
    const aOverduePct = aClientsTotal > 0 ? Math.round((aClientsDueOrOverdue / aClientsTotal) * 100) : 0;
    if (aOverduePct >= 50 && aClientsVeryOverdue === 0) {
      items.push({
        text: `${aOverduePct}% of your A-clients are due or overdue for outreach`,
        rec: "Block 30 minutes today to work through your A-client list",
        urgent: true,
      });
    }
    if (wtdReferralAsks === 0) {
      items.push({
        text: `No referral asks logged this week`,
        rec: "Add a referral ask intent to your next 1–2 touches today",
        urgent: wdElapsed >= 3,
      });
    } else if (wtdReferralAsks < 5 && wdElapsed >= 4) {
      items.push({
        text: `${wtdReferralAsks}/5 referral asks this week — ${5 - wtdReferralAsks} more to hit goal`,
        rec: "Check the Referral Ask Opportunities section below",
        urgent: false,
      });
    }
    const agentPct = wtdOutbound > 0 ? Math.round((wtdAgents / wtdOutbound) * 100) : 0;
    if (agentPct < 30 && wtdOutbound >= 3) {
      items.push({
        text: `Agent touches are ${agentPct}% of your outreach this week (target 40%+)`,
        rec: "Text or call 2–3 agents in your network before end of week",
        urgent: false,
      });
    }
    if (wow <= -30 && out7Prev > 0) {
      items.push({
        text: `Outreach dropped ${Math.abs(wow)}% this week vs last (${out7} vs ${out7Prev} touches)`,
        rec: "Identify what changed and block focused outreach time tomorrow",
        urgent: true,
      });
    }

    // Business intelligence insights
    const { sourceByCategory, totalSourced, activeCount, closedGci } = bizMetrics;
    const agentSrc = sourceByCategory["Agent"];
    if (totalSourced > 0 && agentSrc) {
      const agentSharePct = Math.round((agentSrc.count / totalSourced) * 100);
      if (agentSharePct < 25) {
        items.push({
          text: `Only ${agentSharePct}% of your deals are coming from agent referrals`,
          rec: "Increase agent outreach — target 2 new agent touches this week",
          urgent: false,
        });
      }
    }
    if (activeCount === 0) {
      items.push({
        text: "No active deals in your pipeline",
        rec: "Focus prospecting efforts on buyer and seller conversations",
        urgent: true,
      });
    } else if (activeCount <= 2) {
      items.push({
        text: `Only ${activeCount} active deal${activeCount !== 1 ? "s" : ""} in your pipeline`,
        rec: "Pipeline is thin — prioritize converting warm conversations into active opps",
        urgent: false,
      });
    }

    return items.slice(0, 6);
  }, [aClientsVeryOverdue, aClientsTotal, aClientsDueOrOverdue, wtdReferralAsks, wdElapsed, wtdAgents, wtdOutbound, wow, out7, out7Prev, bizMetrics]);

  // ── Data fetch ───────────────────────────────────────────────────────────────

  async function fetchAll() {
    setError(null);
    const now = new Date();
    const today = localDateStr(now);

    const since35 = new Date(now);
    since35.setDate(since35.getDate() - 35);
    since35.setHours(0, 0, 0, 0);

    const { data: tRaw, error: tErr } = await supabase
      .from("touches")
      .select("id, contact_id, direction, occurred_at, intent")
      .eq("direction", "outbound")
      .gte("occurred_at", since35.toISOString())
      .limit(20000);

    if (tErr) { setError(`Touches fetch: ${tErr.message}`); return; }
    const tAll = (tRaw ?? []) as Touch[];

    const byDay: Record<string, number> = {};
    for (const t of tAll) {
      const ds = localDateStr(new Date(t.occurred_at));
      byDay[ds] = (byDay[ds] ?? 0) + 1;
    }
    setTodayCount(byDay[today] ?? 0);

    {
      let s = 0;
      const check = new Date(now);
      check.setHours(12, 0, 0, 0);
      for (let i = 0; i < 36; i++) {
        if (isWeekendDay(check)) { check.setDate(check.getDate() - 1); continue; }
        const ds = localDateStr(check);
        const isToday = ds === today;
        const count = byDay[ds] ?? 0;
        if (count >= dailyGoal) { s++; check.setDate(check.getDate() - 1); }
        else if (isToday) { check.setDate(check.getDate() - 1); }
        else { break; }
      }
      setStreak(s);
    }

    const since7 = new Date(now); since7.setDate(since7.getDate() - 7);
    const since14 = new Date(now); since14.setDate(since14.getDate() - 14);
    const since30 = new Date(now); since30.setDate(since30.getDate() - 30);
    const monday = startOfWeekMonday(now);

    const t7 = tAll.filter(t => new Date(t.occurred_at) >= since7);
    const tPrev7 = tAll.filter(t => new Date(t.occurred_at) >= since14 && new Date(t.occurred_at) < since7);
    const t30 = tAll.filter(t => new Date(t.occurred_at) >= since30);
    const tWtd = tAll.filter(t => new Date(t.occurred_at) >= monday);

    setOut7(t7.length);
    setOut7Prev(tPrev7.length);
    setOut30(t30.length);
    setRefAsks30(t30.filter(t => t.intent === "referral_ask").length);
    setWtdOutbound(tWtd.length);
    setWtdReferralAsks(tWtd.filter(t => t.intent === "referral_ask").length);

    const weeks: WeekSummary[] = [];
    for (let w = 0; w < 4; w++) {
      const weekStart = startOfWeekMonday(now);
      weekStart.setDate(weekStart.getDate() - w * 7);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      const weekTouches = tAll.filter(t => { const d = new Date(t.occurred_at); return d >= weekStart && d < weekEnd; });
      const days = [];
      for (let d = 0; d < 5; d++) {
        const day = new Date(weekStart);
        day.setDate(day.getDate() + d);
        const ds = localDateStr(day);
        days.push({ dateStr: ds, count: byDay[ds] ?? 0, isToday: ds === today, isFuture: day > now });
      }
      weeks.push({
        label: weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        weekStart,
        outbound: weekTouches.length,
        agents: 0,
        refAsks: weekTouches.filter(t => t.intent === "referral_ask").length,
        daysGoal: w === 0 ? weekdaysElapsed(now) * dailyGoal : 5 * dailyGoal,
        days,
      });
    }

    const { data: cRaw, error: cErr } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, created_at")
      .neq("archived", true)
      .limit(20000);
    if (cErr) { setError(`Contacts fetch: ${cErr.message}`); return; }
    const cs = (cRaw ?? []) as Contact[];
    setAllContacts(cs);
    setContactsTotal(cs.length);

    const catById = new Map<string, string>();
    cs.forEach(c => catById.set(c.id, c.category));

    setAgents7(t7.filter(t => (catById.get(t.contact_id) || "").toLowerCase() === "agent").length);
    setWtdAgents(tWtd.filter(t => (catById.get(t.contact_id) || "").toLowerCase() === "agent").length);

    for (const week of weeks) {
      const weekEnd = new Date(week.weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      week.agents = tAll.filter(t => {
        const d = new Date(t.occurred_at);
        return d >= week.weekStart && d < weekEnd && (catById.get(t.contact_id) || "").toLowerCase() === "agent";
      }).length;
    }
    setWeeklyHistory([...weeks]);

    const { data: loRaw, error: loErr } = await supabase
      .from("contact_last_outbound")
      .select("contact_id, last_outbound_at")
      .limit(20000);
    if (loErr) { setError(`LastOutbound fetch: ${loErr.message}`); return; }
    const loMap = new Map<string, string | null>();
    (loRaw ?? []).forEach((r: any) => loMap.set(r.contact_id, r.last_outbound_at));

    const aClients = cs.filter(c => (c.category || "").toLowerCase() === "client" && (c.tier || "").toUpperCase() === "A");
    setAClientsTotal(aClients.length);
    let due = 0, very = 0;
    for (const c of aClients) {
      const last = loMap.get(c.id) ?? null;
      const cad = cadenceDays(c.category, c.tier);
      if (!last) { due++; continue; }
      const d = daysSince(last);
      if (d >= cad) { due++; if (d >= cad + 14) very++; }
    }
    setAClientsDueOrOverdue(due);
    setAClientsVeryOverdue(very);

    const avoided: AvoidedContact[] = [];
    for (const c of cs) {
      const cad = cadenceDays(c.category, c.tier);
      const last = loMap.get(c.id) ?? null;
      if (last) {
        const d = daysSince(last);
        if (d >= cad * 2) avoided.push({ id: c.id, display_name: c.display_name, category: c.category, tier: c.tier, days: d, cadence: cad, overdueBy: d - cad });
      } else {
        const age = daysSince(c.created_at);
        if (age >= cad) avoided.push({ id: c.id, display_name: c.display_name, category: c.category, tier: c.tier, days: null, cadence: cad, overdueBy: age });
      }
    }
    avoided.sort((a, b) => b.overdueBy - a.overdueBy);
    setAvoidedContacts(avoided.slice(0, 12));

    const complianceCats = ["agent", "client", "sphere", "developer", "vendor"];
    const comp: Record<string, CatCompliance> = {};
    for (const cat of complianceCats) {
      const group = cs.filter(c => (c.category || "").toLowerCase() === cat);
      if (group.length === 0) continue;
      const onCadence = group.filter(c => {
        const last = loMap.get(c.id) ?? null;
        if (!last) return false;
        return daysSince(last) < cadenceDays(c.category, c.tier);
      }).length;
      comp[cat] = { total: group.length, onCadence };
    }
    setCatCompliance(comp);

    // Fetch all deals (all time for business intelligence)
    const pipelineRes = await fetch("/api/pipeline?include_all=1");
    if (pipelineRes.ok) {
      const pj = await pipelineRes.json().catch(() => ({}));
      const deals: Deal[] = pj.deals ?? [];
      setAllDeals(deals);

      // refSources is now a useMemo derived from allDeals + timeframe
    }

    const [refAskRaw, closedDealRaw] = await Promise.all([
      supabase.from("touches").select("contact_id, occurred_at")
        .eq("intent", "referral_ask").eq("direction", "outbound")
        .order("occurred_at", { ascending: false }).limit(5000),
      supabase.from("deals").select("contact_id").eq("pipeline_status", "past_client").limit(5000),
    ]);

    const lastAskMap = new Map<string, string>();
    for (const t of refAskRaw.data ?? []) {
      if (!lastAskMap.has(t.contact_id)) lastAskMap.set(t.contact_id, t.occurred_at);
    }
    const closedDealCount = new Map<string, number>();
    for (const d of closedDealRaw.data ?? []) {
      closedDealCount.set(d.contact_id, (closedDealCount.get(d.contact_id) ?? 0) + 1);
    }

    const ASK_CADENCE = 90;
    const opps: RefAskOpportunity[] = [];
    for (const c of cs) {
      const cat = (c.category || "").toLowerCase();
      if (cat !== "client" && cat !== "sphere" && cat !== "agent") continue;
      const lastAsk = lastAskMap.get(c.id) ?? null;
      const daysSinceLastAsk = lastAsk ? daysSince(lastAsk) : null;
      if (daysSinceLastAsk !== null && daysSinceLastAsk < 30) continue;
      const lastOut = loMap.get(c.id) ?? null;
      const daysSinceOutbound = lastOut ? daysSince(lastOut) : null;
      const closedDeals = closedDealCount.get(c.id) ?? 0;
      const tier = (c.tier || "").toUpperCase();
      let score = 0;
      let reason = "";
      if (daysSinceLastAsk === null) { score += 100; reason = "Never asked for a referral"; }
      else if (daysSinceLastAsk >= ASK_CADENCE) { score += 60; reason = `Last asked ${daysSinceLastAsk}d ago`; }
      else { score += 20; reason = `Last asked ${daysSinceLastAsk}d ago`; }
      if (cat === "client" && closedDeals > 0) { score += 50; reason = closedDeals > 1 ? `Closed ${closedDeals} deals together` : "Past client — closed a deal together"; }
      if (tier === "A") score += 30;
      else if (tier === "B") score += 15;
      if (daysSinceOutbound !== null && daysSinceOutbound <= 21) score += 20;
      opps.push({ id: c.id, display_name: c.display_name, category: c.category, tier: c.tier, daysSinceLastAsk, daysSinceOutbound, closedDeals, score, reason });
    }
    opps.sort((a, b) => b.score - a.score);
    setRefOpportunities(opps.slice(0, 5));

    // Load referral potential contacts
    fetch("/api/insights/referral-potential")
      .then(r => r.json())
      .then(j => { if (j.top_potential) setRefPotential(j); })
      .catch(() => {});

    // Load communication patterns
    fetch("/api/voice/patterns")
      .then(r => r.json())
      .then(j => { if (j.channel_stats) setCommPatterns(j); })
      .catch(() => {});
  }

  async function generateBrief() {
    setAiBriefLoading(true);
    setAiBrief(null);
    try {
      const { closedGci, projectedGci, closedCount, activeCount, buyers, sellers, avgClosePrice, sourceByCategory, totalSourced, neighborhoods, developerCount, priceBuckets } = bizMetrics;

      const tfLabel = TF_LABELS[timeframe];

      const srcLines = Object.entries(sourceByCategory)
        .map(([k, v]) => `${k}: ${v.count} deals (${Math.round(v.count / Math.max(totalSourced, 1) * 100)}%, GCI ${fmt$(v.gci)})`)
        .join("; ");

      const geoLines = neighborhoods.slice(0, 5).map(n => `${n.name}: ${n.count}`).join(", ");

      const priceLines = Object.entries(priceBuckets).map(([k, v]) => `${k}: ${v}`).join(", ");

      const summary = `Timeframe: ${tfLabel}
Active pipeline: ${activeCount} deals, projected GCI ${fmt$(projectedGci)}
Closed deals: ${closedCount} (${buyers} buyers, ${sellers} sellers), closed GCI ${fmt$(closedGci)}, avg close price ${fmt$(avgClosePrice)}
Referral sources: ${srcLines || "none tagged"}
Geographic concentration: ${geoLines || "no neighborhoods tagged"}
Price distribution: ${priceLines}
Database: ${contactsTotal.toLocaleString()} contacts, ${developerCount} developers
Weekly outreach: ${wtdOutbound} WTD (goal ${wtdPace}), ${wtdAgents} agent touches, ${wtdReferralAsks} referral asks
A-client cadence: ${aClientsDueOrOverdue}/${aClientsTotal} due or overdue`;

      const res = await fetch("/api/insights/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary }),
      });
      const j = await res.json();
      setAiBrief(j.brief ?? "No brief returned.");
    } catch (e) {
      setAiBrief("Failed to generate brief. Check API key.");
    } finally {
      setAiBriefLoading(false);
    }
  }

  async function logReferralAsk(contactId: string) {
    setLoggingAsk(contactId);
    await supabase.from("touches").insert({
      contact_id: contactId,
      channel: "text",
      direction: "outbound",
      intent: "referral_ask",
      occurred_at: new Date().toISOString(),
      source: "manual",
    });
    setLoggedAskIds((prev) => new Set([...prev, contactId]));
    setLoggingAsk(null);
    setRefAsks30((n) => n + 1);
  }

  useEffect(() => {
    let alive = true;
    const init = async () => {
      const { data } = await supabase.auth.getSession();
      if (!alive) return;
      if (!data.session) { window.location.href = "/login"; return; }
      setDailyGoal(await loadDailyGoal(data.session.user.id));
      setReady(true);
      await fetchAll();
    };
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      if (!session) window.location.href = "/login";
    });
    init();
    return () => { alive = false; sub.subscription.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) return <div className="card cardPad">Loading…</div>;

  const today = localDateStr(new Date());
  const todayDone = todayCount >= dailyGoal;

  const WTD_AGENT_TARGET = 15;
  const WTD_REF_ASK_TARGET = 5;

  function kpiBar(value: number, target: number, label: string) {
    const ratio = target > 0 ? Math.min(value / target, 1) : 0;
    const pctVal = Math.round(ratio * 100);
    const color = pctVal >= 100 ? "#0b6b2a" : pctVal >= 60 ? "rgba(140,90,0,.9)" : "#8a0000";
    return (
      <div key={label}>
        <div className="rowBetween" style={{ marginBottom: 4 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "rgba(18,18,18,.6)" }}>{label}</span>
          <span style={{ fontSize: 12, fontWeight: 900, color }}>{value}<span style={{ color: "rgba(18,18,18,.35)", fontWeight: 400 }}>/{target}</span></span>
        </div>
        <div style={{ height: 5, borderRadius: 3, background: "rgba(0,0,0,.08)", overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${pctVal}%`, background: color, borderRadius: 3 }} />
        </div>
      </div>
    );
  }

  const { closedGci, projectedGci, closedCount, activeCount, buyers, sellers, avgClosePrice, priceBuckets, neighborhoods, sourceByCategory, totalSourced, catCounts, developerCount, growthByMonth } = bizMetrics;

  const tfLabel = TF_LABELS[timeframe];

  const maxGrowth = Math.max(...growthByMonth.map(m => m.count), 1);

  return (
    <div className="stack">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div className="rowBetween">
        <div>
          <h1 className="h1">Business Intelligence</h1>
          <div className="subtle" style={{ marginTop: 6 }}>
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </div>
        </div>
        <div className="row">
          {(["quarter", "ytd", "trailing12", "trailing24", "all"] as Timeframe[]).map(tf => (
            <button
              key={tf}
              className={`btn${timeframe === tf ? " btnPrimary" : ""}`}
              style={{ fontSize: 12 }}
              onClick={() => { setTimeframe(tf); setAiBrief(null); }}
            >
              {TF_LABELS[tf]}
            </button>
          ))}
          <button className="btn" onClick={fetchAll}>Refresh</button>
          <a className="btn" href="/reports">Reports</a>
        </div>
      </div>

      {error && <div className="alert alertError">{error}</div>}

      {/* ── Pipeline Snapshot ────────────────────────────────────────────────── */}
      <div className="card cardPad">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 14 }}>Pipeline snapshot</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div style={{ padding: "12px", background: "rgba(0,0,0,.025)", borderRadius: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(18,18,18,.45)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>Current pipeline</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {[
                { label: "Active deals", value: activeCount.toString() },
                { label: "Projected GCI", value: fmt$(projectedGci) },
              ].map(item => (
                <div key={item.label}>
                  <div style={{ fontWeight: 900, fontSize: 22, lineHeight: 1.1 }}>{item.value}</div>
                  <div style={{ fontWeight: 700, fontSize: 11, marginTop: 4, color: "rgba(18,18,18,.55)" }}>{item.label}</div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ padding: "12px", background: "rgba(0,0,0,.025)", borderRadius: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(18,18,18,.45)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>Closed — {tfLabel}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              {[
                { label: "Closed deals", value: closedCount.toString(), sub: `${buyers}B / ${sellers}S` },
                { label: "Closed GCI", value: fmt$(closedGci) },
                { label: "Avg close price", value: avgClosePrice > 0 ? fmt$(avgClosePrice) : "—" },
              ].map(item => (
                <div key={item.label}>
                  <div style={{ fontWeight: 900, fontSize: 22, lineHeight: 1.1 }}>{item.value}</div>
                  <div style={{ fontWeight: 700, fontSize: 11, marginTop: 4, color: "rgba(18,18,18,.55)" }}>{item.label}</div>
                  {"sub" in item && item.sub && <div style={{ fontSize: 11, color: "rgba(18,18,18,.38)", marginTop: 2 }}>{item.sub}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Business Source ──────────────────────────────────────────────────── */}
      <div className="card cardPad">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 4 }}>Business source — {tfLabel}</div>
        <div className="subtle" style={{ fontSize: 12, marginBottom: 14 }}>Where your deals originate</div>
        {totalSourced === 0 ? (
          <div className="subtle" style={{ fontSize: 13 }}>No referral sources tagged yet — add referral source on deals to track this.</div>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {Object.entries(sourceByCategory)
              .sort((a, b) => b[1].count - a[1].count)
              .map(([cat, v]) => {
                const pct = Math.round(v.count / totalSourced * 100);
                const color = cat === "Agent" ? "#1a5fb4" : cat === "Client" ? "#0b6b2a" : cat === "Sphere" ? "#6a329f" : "rgba(18,18,18,.5)";
                return (
                  <div key={cat}>
                    <div className="rowBetween" style={{ marginBottom: 4 }}>
                      <span style={{ fontWeight: 700, fontSize: 13 }}>{cat}</span>
                      <span style={{ fontSize: 12, color: "rgba(18,18,18,.5)" }}>
                        {v.count} deal{v.count !== 1 ? "s" : ""} · {pct}%{v.gci > 0 ? ` · ${fmt$(v.gci)} GCI` : ""}
                      </span>
                    </div>
                    <div style={{ height: 8, borderRadius: 4, background: "rgba(0,0,0,.07)", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 4 }} />
                    </div>
                  </div>
                );
              })}
            {bizMetrics.noSource > 0 && (
              <div style={{ fontSize: 12, color: "rgba(18,18,18,.4)", marginTop: 4 }}>
                {bizMetrics.noSource} deal{bizMetrics.noSource !== 1 ? "s" : ""} with no referral source tagged
              </div>
            )}
          </div>
        )}

        {/* Top individual referral sources */}
        {refSources.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: "rgba(18,18,18,.6)" }}>Top sources by GCI</div>
            <div className="stack" style={{ gap: 0 }}>
              {refSources.slice(0, 5).map((s, i) => (
                <div key={s.contact_id} style={{ padding: "9px 0", borderBottom: i < Math.min(refSources.length, 5) - 1 ? "1px solid rgba(0,0,0,.05)" : undefined, display: "flex", gap: 12, alignItems: "center" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
                      <a href={`/contacts/${s.contact_id}`} style={{ fontWeight: 800, fontSize: 13 }}>{s.display_name}</a>
                      {s.category && <span className="badge" style={{ fontSize: 11 }}>{s.category}</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(18,18,18,.45)", marginTop: 2 }}>
                      {s.deals_total} deal{s.deals_total !== 1 ? "s" : ""} · {s.deals_closed} closed
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    {s.closed_gci > 0 && <div style={{ fontWeight: 900, fontSize: 15, color: "#0b6b2a" }}>{fmt$(s.closed_gci)}</div>}
                    {s.pipeline_gci > 0 && <div style={{ fontSize: 12, color: "rgba(18,18,18,.45)" }}>{fmt$(s.pipeline_gci)} pipeline</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Geographic Distribution ──────────────────────────────────────────── */}
      <div className="card cardPad">
        <div className="rowBetween" style={{ alignItems: "flex-start", marginBottom: 4 }}>
          <div style={{ fontWeight: 900, fontSize: 15 }}>Geographic distribution</div>
          <button
            className="btn"
            style={{ fontSize: 11, padding: "3px 10px" }}
            disabled={backfilling}
            onClick={async () => {
              setBackfilling(true);
              setBackfillResult(null);
              const res = await fetch("/api/pipeline/backfill-neighborhoods", { method: "POST" });
              const j = await res.json().catch(() => ({}));
              setBackfillResult(res.ok ? `Updated ${j.updated} of ${j.total} deals` : (j.error ?? "Failed"));
              setBackfilling(false);
              if (res.ok && j.updated > 0) window.location.reload();
            }}
          >
            {backfilling ? "Geocoding…" : "Backfill neighborhoods"}
          </button>
        </div>
        <div className="subtle" style={{ fontSize: 12, marginBottom: backfillResult ? 6 : 14 }}>Active + closed deals by neighborhood — parsed from address when not explicitly set</div>
        {backfillResult && <div style={{ fontSize: 12, color: "#0b6b2a", marginBottom: 10 }}>{backfillResult}</div>}
        {neighborhoods.length === 0 ? (
          <div className="subtle" style={{ fontSize: 13 }}>No neighborhood data yet. Click "Backfill neighborhoods" to geocode existing deals, or add addresses via autocomplete on the Pipeline page.</div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {neighborhoods.map((n, i) => {
              const maxCount = neighborhoods[0].count;
              const pct = Math.round(n.count / maxCount * 100);
              return (
                <div key={n.name}>
                  <div className="rowBetween" style={{ marginBottom: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{n.name}</span>
                    <span style={{ fontSize: 12, color: "rgba(18,18,18,.5)" }}>
                      {n.count} deal{n.count !== 1 ? "s" : ""}{n.gci > 0 ? ` · ${fmt$(n.gci)} GCI` : ""}
                    </span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: "rgba(0,0,0,.07)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: i === 0 ? "var(--ink)" : "rgba(18,18,18,.35)", borderRadius: 3 }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Price Distribution ───────────────────────────────────────────────── */}
      <div className="card cardPad">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 4 }}>Price distribution — closed deals, {tfLabel}</div>
        <div className="subtle" style={{ fontSize: 12, marginBottom: 14 }}>How your transactions are distributed across price points</div>
        {closedCount === 0 ? (
          <div className="subtle" style={{ fontSize: 13 }}>No closed deals in this timeframe.</div>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            {Object.entries(priceBuckets).map(([label, count]) => {
              const pct = closedCount > 0 ? Math.round(count / closedCount * 100) : 0;
              return (
                <div key={label}>
                  <div className="rowBetween" style={{ marginBottom: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: 13 }}>{label}</span>
                    <span style={{ fontSize: 12, color: "rgba(18,18,18,.5)" }}>{count} deal{count !== 1 ? "s" : ""} · {pct}%</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 4, background: "rgba(0,0,0,.07)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pct}%`, background: "rgba(18,18,18,.5)", borderRadius: 4 }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Database Composition ─────────────────────────────────────────────── */}
      <div className="card cardPad">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 14 }}>Database composition</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          {/* Category breakdown */}
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: "rgba(18,18,18,.6)" }}>By category</div>
            <div className="stack" style={{ gap: 6 }}>
              {Object.entries(catCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([cat, count]) => (
                  <div key={cat} className="rowBetween">
                    <span style={{ fontSize: 13, textTransform: "capitalize", fontWeight: 600 }}>{cat}</span>
                    <span style={{ fontSize: 13, fontWeight: 800 }}>{count.toLocaleString()}</span>
                  </div>
                ))}
              <div className="rowBetween" style={{ borderTop: "1px solid rgba(0,0,0,.08)", paddingTop: 6, marginTop: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>Total</span>
                <span style={{ fontSize: 13, fontWeight: 900 }}>{contactsTotal.toLocaleString()}</span>
              </div>
            </div>
          </div>

          {/* Contact growth */}
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: "rgba(18,18,18,.6)" }}>Monthly additions (12mo)</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 60 }}>
              {growthByMonth.map((m, i) => {
                const h = maxGrowth > 0 ? Math.max(2, Math.round((m.count / maxGrowth) * 60)) : 2;
                return (
                  <div
                    key={m.label}
                    title={`${m.label}: ${m.count}`}
                    style={{
                      flex: 1,
                      height: h,
                      background: i === growthByMonth.length - 1 ? "var(--ink)" : "rgba(18,18,18,.25)",
                      borderRadius: "2px 2px 0 0",
                    }}
                  />
                );
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ fontSize: 10, color: "rgba(18,18,18,.35)" }}>{growthByMonth[0]?.label}</span>
              <span style={{ fontSize: 10, color: "rgba(18,18,18,.35)" }}>{growthByMonth[growthByMonth.length - 1]?.label}</span>
            </div>
            <div style={{ fontSize: 12, color: "rgba(18,18,18,.45)", marginTop: 8 }}>
              {developerCount} developer relationship{developerCount !== 1 ? "s" : ""}
            </div>
          </div>
        </div>
      </div>

      {/* ── AI Business Brief ─────────────────────────────────────────────────── */}
      <div className="card cardPad">
        <div className="rowBetween" style={{ marginBottom: aiBrief ? 14 : 0 }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 15 }}>AI business brief</div>
            {!aiBrief && <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>Claude analyzes your pipeline, sources, and outreach patterns</div>}
          </div>
          <button
            className="btn btnPrimary"
            style={{ fontSize: 12, flexShrink: 0 }}
            disabled={aiBriefLoading}
            onClick={generateBrief}
          >
            {aiBriefLoading ? "Generating…" : aiBrief ? "Regenerate" : "Generate brief"}
          </button>
        </div>
        {aiBrief && (
          <div style={{ fontSize: 14, lineHeight: 1.65, color: "var(--ink)", borderTop: "1px solid rgba(0,0,0,.07)", paddingTop: 14 }}>
            {aiBrief}
          </div>
        )}
      </div>

      {/* ──────────────────────────────────────────────────────────────────────── */}
      <div style={{ borderTop: "2px solid rgba(0,0,0,.08)", paddingTop: 4 }}>
        <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 4 }}>Accountability</div>
        <div className="subtle" style={{ fontSize: 13 }}>Outreach tracking, cadence health, and referral asks</div>
      </div>

      {/* ── Status Hero ─────────────────────────────────────────────────────── */}
      <div className="card cardPad">
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 24, alignItems: "start" }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 15, color: isOnPace ? "#0b6b2a" : "#8a0000", marginBottom: 6 }}>
              {isOnPace ? "✓ On pace this week" : "⚠ Behind this week"}
            </div>
            {!isOnPace && wtdDeficit > 0 && (
              <div style={{ fontSize: 13, color: "#8a0000", marginBottom: 8 }}>
                {wtdDeficit} more touch{wtdDeficit !== 1 ? "es" : ""} needed to get on pace
              </div>
            )}
            {aClientsVeryOverdue > 0 && (
              <div style={{ fontWeight: 700, color: "#8a0000", fontSize: 13, marginBottom: 12 }}>
                ⚠ {aClientsVeryOverdue} A-client{aClientsVeryOverdue !== 1 ? "s" : ""} 14+ days past cadence
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, maxWidth: 500 }}>
              {kpiBar(wtdOutbound, wtdPace, "Outreach WTD")}
              {kpiBar(wtdAgents, Math.max(1, Math.round(WTD_AGENT_TARGET * wdElapsed / 5)), "Agent touches")}
              {kpiBar(wtdReferralAsks, Math.max(1, Math.round(WTD_REF_ASK_TARGET * wdElapsed / 5)), "Referral asks")}
            </div>
          </div>
          <div className="row" style={{ gap: 20, flexShrink: 0 }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 900, fontSize: 34, lineHeight: 1, color: todayDone ? "#0b6b2a" : "var(--ink)" }}>{todayCount}</div>
              <div className="subtle" style={{ fontSize: 11, marginTop: 3 }}>Today / {dailyGoal}</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 900, fontSize: 34, lineHeight: 1, color: streak > 0 ? "#0b6b2a" : "rgba(18,18,18,.3)" }}>{streak}</div>
              <div className="subtle" style={{ fontSize: 11, marginTop: 3 }}>Streak</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 900, fontSize: 34, lineHeight: 1 }}>{health.total}</div>
              <div className="subtle" style={{ fontSize: 11, marginTop: 3 }}>Score / 100</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Insights ────────────────────────────────────────────────────────── */}
      {quickInsights.length > 0 && (
        <div className="card cardPad">
          <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 12 }}>Insights</div>
          <div className="stack" style={{ gap: 10 }}>
            {quickInsights.map((ins, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span style={{ fontSize: 13, flexShrink: 0, marginTop: 1 }}>{ins.urgent ? "⚠" : "→"}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: ins.urgent ? 700 : 600, color: ins.urgent ? "#8a0000" : "var(--ink)" }}>
                    {ins.text}
                  </div>
                  <div style={{ fontSize: 12, color: "rgba(18,18,18,.5)", marginTop: 2 }}>{ins.rec}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Contacts Slipping ───────────────────────────────────────────────── */}
      <div className="card cardPad">
        <button
          onClick={() => setSlippingOpen(v => !v)}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", width: "100%", textAlign: "left" }}
        >
          <div className="rowBetween" style={{ alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 15 }}>
                Contacts slipping
                {avoidedContacts.length > 0 && (
                  <span style={{ marginLeft: 8, fontSize: 13, fontWeight: 700, color: "#8a0000" }}>
                    {avoidedContacts.length} need attention
                  </span>
                )}
                {avoidedContacts.length === 0 && (
                  <span style={{ marginLeft: 8, fontSize: 13, fontWeight: 600, color: "#0b6b2a" }}>✓ clean</span>
                )}
              </div>
              <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>2× past cadence or never touched</div>
            </div>
            <span style={{ fontSize: 13, color: "rgba(18,18,18,.4)", flexShrink: 0 }}>{slippingOpen ? "▲" : "▼"}</span>
          </div>
        </button>
        {slippingOpen && avoidedContacts.length > 0 && (
          <div className="stack" style={{ gap: 0, marginTop: 14 }}>
            {avoidedContacts.map((c, i) => (
              <div key={c.id} className="rowBetween" style={{ padding: "10px 0", borderBottom: i < avoidedContacts.length - 1 ? "1px solid rgba(0,0,0,.06)" : undefined, alignItems: "center", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                    <a href={`/contacts/${c.id}`} style={{ fontWeight: 800, wordBreak: "break-word" }}>{c.display_name}</a>
                    <span className="subtle" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                      {c.category}{c.tier ? ` • Tier ${c.tier}` : ""}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "#8a0000", marginTop: 2 }}>
                    {c.days === null
                      ? `Never touched — in system ${c.overdueBy}d`
                      : `${c.days}d since last contact — ${c.overdueBy}d past cadence (${c.cadence}d)`}
                  </div>
                </div>
                <a className="btn" href={`/contacts/${c.id}`} style={{ textDecoration: "none", whiteSpace: "nowrap", fontSize: 12, flexShrink: 0 }}>Open →</a>
              </div>
            ))}
          </div>
        )}
        {slippingOpen && avoidedContacts.length === 0 && (
          <div className="subtle" style={{ marginTop: 12, fontSize: 13 }}>✓ No contacts 2× past cadence — clean slate.</div>
        )}
      </div>

      {/* ── Referral Source ROI ─────────────────────────────────────────────── */}
      {refSources.length > 0 && (
        <div className="card cardPad">
          <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 4 }}>Referral source ROI — all time</div>
          <div className="subtle" style={{ fontSize: 12, marginBottom: 14 }}>Who's driving your deal flow — sorted by total GCI</div>
          <div className="stack" style={{ gap: 0 }}>
            {refSources.map((s, i) => (
              <div key={s.contact_id} style={{ padding: "10px 0", borderBottom: i < refSources.length - 1 ? "1px solid rgba(0,0,0,.05)" : undefined, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
                    <a href={`/contacts/${s.contact_id}`} style={{ fontWeight: 800, fontSize: 14 }}>{s.display_name}</a>
                    {s.category && <span className="badge" style={{ fontSize: 11 }}>{s.category}</span>}
                  </div>
                  <div className="row" style={{ marginTop: 4, gap: 6, flexWrap: "wrap" }}>
                    <span className="badge">{s.deals_total} deal{s.deals_total !== 1 ? "s" : ""} referred</span>
                    {s.deals_closed > 0 && (
                      <span className="badge" style={{ background: "rgba(11,107,42,.08)", color: "#0b6b2a", borderColor: "rgba(11,107,42,.2)", fontWeight: 700 }}>
                        {s.deals_closed} closed{s.closed_value > 0 ? ` · $${s.closed_value.toLocaleString()}` : ""}
                      </span>
                    )}
                    {s.pipeline_value > 0 && (
                      <span className="badge">${s.pipeline_value.toLocaleString()} in pipeline</span>
                    )}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  {s.closed_gci > 0 && <div style={{ fontWeight: 900, fontSize: 18, color: "#0b6b2a" }}>{fmt$(s.closed_gci)}</div>}
                  {s.pipeline_gci > 0 && <div style={{ fontSize: 12, color: "rgba(18,18,18,.45)" }}>{fmt$(s.pipeline_gci)} projected</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Daily Outreach Log ──────────────────────────────────────────────── */}
      <div className="card cardPad">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 14 }}>Daily outreach — last 4 weeks</div>
        <div style={{ display: "grid", gridTemplateColumns: "68px repeat(5, 1fr)", gap: 4, marginBottom: 6 }}>
          <div />
          {["Mon", "Tue", "Wed", "Thu", "Fri"].map(d => (
            <div key={d} style={{ textAlign: "center", fontSize: 11, fontWeight: 700, color: "rgba(18,18,18,.4)", paddingBottom: 2 }}>{d}</div>
          ))}
        </div>
        <div className="stack" style={{ gap: 4 }}>
          {weeklyHistory.map((week, wi) => (
            <div key={wi} style={{ display: "grid", gridTemplateColumns: "68px repeat(5, 1fr)", gap: 4, alignItems: "center" }}>
              <div style={{ fontSize: 11, color: "rgba(18,18,18,.45)", fontWeight: wi === 0 ? 800 : 400, paddingRight: 4 }}>
                {wi === 0 ? "This wk" : week.label}
              </div>
              {week.days.map((day, di) => {
                const hit = day.count >= dailyGoal;
                const partial = day.count > 0 && !hit;
                const missed = !day.isFuture && !day.isToday && day.count === 0;
                const style: React.CSSProperties = {
                  textAlign: "center",
                  padding: "7px 4px",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: day.isFuture ? 400 : 700,
                  background: day.isFuture ? "transparent" : hit ? "rgba(11,107,42,.12)" : partial ? "rgba(170,110,0,.1)" : missed ? "rgba(160,0,0,.07)" : "rgba(0,0,0,.04)",
                  color: day.isFuture ? "rgba(18,18,18,.2)" : hit ? "#0b6b2a" : partial ? "rgba(130,80,0,.9)" : missed ? "rgba(140,0,0,.65)" : "rgba(18,18,18,.4)",
                  border: day.isToday ? "2px solid rgba(18,18,18,.3)" : "1px solid transparent",
                };
                return <div key={di} style={style}>{day.isFuture ? "—" : day.count}</div>;
              })}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: "rgba(18,18,18,.4)" }}>
          Goal {dailyGoal}/weekday •{" "}
          <span style={{ color: "#0b6b2a", fontWeight: 700 }}>■ Hit</span>{" "}
          <span style={{ color: "rgba(130,80,0,.9)", fontWeight: 700 }}>■ Partial</span>{" "}
          <span style={{ color: "rgba(140,0,0,.65)", fontWeight: 700 }}>■ Missed</span>
        </div>
      </div>

      {/* ── Weekly Summary Table ────────────────────────────────────────────── */}
      <div className="card cardPad">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 14 }}>Weekly summary</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid rgba(0,0,0,.08)" }}>
                {["Week", "Outreach", "Goal", "vs Goal", "Agents", "Ref asks"].map(h => (
                  <th key={h} style={{ padding: "4px 12px", textAlign: h === "Week" ? "left" : "center", fontWeight: 700, color: "rgba(18,18,18,.5)", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeklyHistory.map((week, wi) => {
                const diff = week.outbound - week.daysGoal;
                const onPace = week.outbound >= week.daysGoal * 0.8;
                return (
                  <tr key={wi} style={{ borderBottom: "1px solid rgba(0,0,0,.05)" }}>
                    <td style={{ padding: "9px 12px", fontWeight: wi === 0 ? 800 : 400 }}>{wi === 0 ? "This week" : week.label}</td>
                    <td style={{ padding: "9px 12px", textAlign: "center", fontWeight: 700 }}>{week.outbound}</td>
                    <td style={{ padding: "9px 12px", textAlign: "center", color: "rgba(18,18,18,.45)" }}>{week.daysGoal}</td>
                    <td style={{ padding: "9px 12px", textAlign: "center", fontWeight: 700, color: onPace ? "#0b6b2a" : "#8a0000" }}>
                      {diff >= 0 ? `+${diff}` : `${diff}`}
                    </td>
                    <td style={{ padding: "9px 12px", textAlign: "center" }}>{week.agents}</td>
                    <td style={{ padding: "9px 12px", textAlign: "center" }}>{week.refAsks}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Category Health ─────────────────────────────────────────────────── */}
      {Object.keys(catCompliance).length > 0 && (
        <div className="card cardPad">
          <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 14 }}>Category health — % on cadence</div>
          <div className="stack" style={{ gap: 12 }}>
            {Object.entries(catCompliance).map(([cat, stat]) => {
              const ratio = stat.total > 0 ? stat.onCadence / stat.total : 0;
              const pctVal = Math.round(ratio * 100);
              const color = pctVal >= 70 ? "#0b6b2a" : pctVal >= 40 ? "rgba(140,90,0,.9)" : "#8a0000";
              return (
                <div key={cat}>
                  <div className="rowBetween" style={{ marginBottom: 5 }}>
                    <span style={{ fontWeight: 700, fontSize: 13, textTransform: "capitalize" }}>{cat}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color }}>{stat.onCadence}/{stat.total} ({pctVal}%)</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 4, background: "rgba(0,0,0,.08)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${pctVal}%`, background: color, borderRadius: 4 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Referral Ask Opportunities ──────────────────────────────────────── */}
      {refOpportunities.length > 0 && (
        <div className="card cardPad">
          <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 4 }}>Referral ask opportunities</div>
          <div className="subtle" style={{ fontSize: 12, marginBottom: 14 }}>Top 5 — ranked by relationship strength + time since last ask</div>
          <div className="stack" style={{ gap: 0 }}>
            {refOpportunities.map((opp, i) => {
              const logged = loggedAskIds.has(opp.id);
              return (
                <div key={opp.id} style={{ padding: "12px 0", borderBottom: i < refOpportunities.length - 1 ? "1px solid rgba(0,0,0,.05)" : undefined, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", opacity: logged ? 0.45 : 1 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                      <a href={`/contacts/${opp.id}`} style={{ fontWeight: 800, fontSize: 14 }}>{opp.display_name}</a>
                      <span className="badge" style={{ fontSize: 11 }}>{opp.category}{opp.tier ? ` · Tier ${opp.tier}` : ""}</span>
                      {opp.closedDeals > 0 && (
                        <span className="badge" style={{ fontSize: 11, background: "rgba(11,107,42,.08)", color: "#0b6b2a", borderColor: "rgba(11,107,42,.2)", fontWeight: 700 }}>
                          {opp.closedDeals} closed deal{opp.closedDeals !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(18,18,18,.55)", marginTop: 4, fontWeight: 600 }}>
                      {opp.reason}
                      {opp.daysSinceOutbound !== null && opp.daysSinceOutbound <= 21
                        ? " · touched recently"
                        : opp.daysSinceOutbound !== null
                        ? ` · last contact ${opp.daysSinceOutbound}d ago`
                        : " · no outbound on record"}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                    <a className="btn" href={`/contacts/${opp.id}`} style={{ fontSize: 12, textDecoration: "none" }}>Open</a>
                    <button className="btn btnPrimary" style={{ fontSize: 12 }} disabled={loggingAsk === opp.id || logged} onClick={() => logReferralAsk(opp.id)}>
                      {logged ? "Logged ✓" : loggingAsk === opp.id ? "…" : "Log ask"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Communication Intelligence ──────────────────────────────────────── */}
      {commPatterns && (
        <div className="card cardPad" style={{ marginTop: 16 }}>
          <div className="rowBetween" style={{ marginBottom: 14 }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 15 }}>Communication intelligence</div>
              <div className="muted small" style={{ marginTop: 2 }}>Last 90 days · reply rates require ≥3 outbound touches per channel</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 22, fontWeight: 900 }}>{commPatterns.total_outbound}</div>
              <div className="muted small">
                outbound touches
                {commPatterns.total_outbound_prior > 0 && (
                  <span style={{ marginLeft: 6, color: commPatterns.total_outbound >= commPatterns.total_outbound_prior ? "#0b6b2a" : "#8a0000", fontWeight: 700 }}>
                    {commPatterns.total_outbound >= commPatterns.total_outbound_prior ? "+" : ""}
                    {commPatterns.total_outbound - commPatterns.total_outbound_prior} vs prior
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Channel reply rates */}
          {commPatterns.channel_stats.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div className="label" style={{ marginBottom: 8 }}>Channel reply rates</div>
              <div className="stack" style={{ gap: 6 }}>
                {commPatterns.channel_stats.map((ch) => (
                  <div key={ch.channel}>
                    <div className="rowBetween" style={{ marginBottom: 3 }}>
                      <span style={{ fontSize: 13, textTransform: "capitalize" }}>{ch.channel.replace("_", " ")}</span>
                      <span style={{ fontSize: 13, fontWeight: 700 }}>
                        {ch.reply_rate !== null
                          ? <span style={{ color: ch.reply_rate >= 50 ? "#0b6b2a" : ch.reply_rate <= 20 ? "#8a0000" : undefined }}>{ch.reply_rate}%</span>
                          : <span className="muted">not enough data</span>}
                        <span className="muted" style={{ fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
                          {ch.outbound} sent · {ch.inbound} replies
                        </span>
                      </span>
                    </div>
                    {ch.reply_rate !== null && (
                      <div style={{ height: 5, background: "rgba(0,0,0,.07)", borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${ch.reply_rate}%`, background: ch.reply_rate >= 50 ? "#0b6b2a" : ch.reply_rate <= 20 ? "#c00" : "#888", borderRadius: 3, transition: "width .4s" }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Category breakdown */}
          {commPatterns.category_stats.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div className="label" style={{ marginBottom: 8 }}>Touches by category (last 30d vs prior 30d)</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {commPatterns.category_stats.map((cat) => {
                  const delta = cat.touches_this - cat.touches_prior;
                  return (
                    <div key={cat.category} className="card cardPad" style={{ padding: "8px 12px", flex: "1 1 120px", minWidth: 110 }}>
                      <div style={{ fontSize: 11, textTransform: "capitalize", color: "rgba(18,18,18,.5)", fontWeight: 700, marginBottom: 2 }}>{cat.category}</div>
                      <div style={{ fontSize: 20, fontWeight: 900 }}>{cat.touches_this}</div>
                      {cat.touches_prior > 0 && (
                        <div style={{ fontSize: 11, fontWeight: 700, color: delta >= 0 ? "#0b6b2a" : "#8a0000" }}>
                          {delta >= 0 ? "+" : ""}{delta} vs prior
                        </div>
                      )}
                      {cat.reply_rate !== null && (
                        <div style={{ fontSize: 11, color: "rgba(18,18,18,.5)", marginTop: 2 }}>{cat.reply_rate}% reply</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Weekly sparkline */}
          {commPatterns.weekly_trend.length >= 4 && (() => {
            const weeks = commPatterns.weekly_trend.slice(-13);
            const max = Math.max(...weeks.map(w => w.count), 1);
            return (
              <div style={{ marginBottom: 16 }}>
                <div className="label" style={{ marginBottom: 8 }}>Weekly outbound trend (last 13 weeks)</div>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 48 }}>
                  {weeks.map((w) => (
                    <div key={w.week} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                      <div
                        style={{
                          width: "100%",
                          height: `${Math.max(4, Math.round((w.count / max) * 40))}px`,
                          background: "var(--ink)",
                          borderRadius: 2,
                          opacity: 0.15 + (w.count / max) * 0.85,
                        }}
                        title={`${w.week}: ${w.count} touches`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Coaching observations */}
          {commPatterns.coaching.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 8 }}>Observations</div>
              <div className="stack" style={{ gap: 6 }}>
                {commPatterns.coaching.map((tip, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ fontSize: 14, flexShrink: 0, marginTop: 1 }}>→</span>
                    <span style={{ fontSize: 13, lineHeight: 1.55 }}>{tip}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Untapped Referral Potential ──────────────────────────────────────── */}
      {refPotential && refPotential.top_potential.length > 0 && (
        <div className="card cardPad" style={{ marginTop: 16 }}>
          <div className="rowBetween" style={{ marginBottom: 12 }}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 15 }}>Untapped referral potential</div>
              <div className="muted small" style={{ marginTop: 2 }}>
                Contacts matching the profile of your {refPotential.profile_size} known referral sources — never referred yet
              </div>
            </div>
          </div>
          <div className="stack">
            {refPotential.top_potential.map((c) => (
              <div key={c.id} style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "10px 0", borderBottom: "1px solid rgba(0,0,0,.05)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <a href={`/contacts/${c.id}`} style={{ fontWeight: 800, fontSize: 14, textDecoration: "none", color: "var(--ink)" }}>
                      {c.display_name}
                    </a>
                    <span className="badge" style={{ fontSize: 11, color: "#7c3aed", borderColor: "rgba(124,58,237,.25)", background: "rgba(124,58,237,.05)" }}>
                      Potential {c.referral_potential}
                    </span>
                    {c.category && <span className="badge" style={{ fontSize: 11 }}>{c.category}</span>}
                    {c.tier && <span className="badge" style={{ fontSize: 11 }}>Tier {c.tier}</span>}
                  </div>
                  {c.match_reasons.length > 0 && (
                    <div className="muted small" style={{ marginTop: 3 }}>
                      Matches: {c.match_reasons.join(" · ")}
                      {c.days_since_contact !== null && ` · last contact ${c.days_since_contact}d ago`}
                    </div>
                  )}
                </div>
                <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                  <a className="btn" href={`/contacts/${c.id}`} style={{ fontSize: 12, textDecoration: "none" }}>Open</a>
                  <button
                    className="btn btnPrimary"
                    style={{ fontSize: 12 }}
                    disabled={loggingAsk === c.id || loggedAskIds.has(c.id)}
                    onClick={() => logReferralAsk(c.id)}
                  >
                    {loggedAskIds.has(c.id) ? "Logged ✓" : loggingAsk === c.id ? "…" : "Log ask"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
