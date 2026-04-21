"use client";

import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

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
  deals_total: number;
  deals_closed: number;
  pipeline_value: number;
  closed_value: number;
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

// ── Helpers ───────────────────────────────────────────────────────────────────

const RULES_KEY = "morning_rules_v1";

function loadDailyGoal(): number {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (!raw) return 5;
    return (JSON.parse(raw) as { totalRecs?: number })?.totalRecs ?? 5;
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

// ── Component ─────────────────────────────────────────────────────────────────

export default function InsightsPage() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dailyGoal, setDailyGoal] = useState(5);

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
  const [refSources, setRefSources] = useState<RefSourceRow[]>([]);
  const [contactsTotal, setContactsTotal] = useState(0);
  const [agentsTotal, setAgentsTotal] = useState(0);
  const [clientsTotal, setClientsTotal] = useState(0);
  const [aClientsTotal, setAClientsTotal] = useState(0);
  const [aClientsDueOrOverdue, setAClientsDueOrOverdue] = useState(0);
  const [aClientsVeryOverdue, setAClientsVeryOverdue] = useState(0);

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

  const quickInsights = useMemo(() => {
    const items: Array<{ text: string; urgent: boolean }> = [];

    if (aClientsVeryOverdue > 0) {
      items.push({ text: `${aClientsVeryOverdue} A-client${aClientsVeryOverdue !== 1 ? "s are" : " is"} 14+ days past cadence — contact immediately`, urgent: true });
    }
    const aOverduePct = aClientsTotal > 0 ? Math.round((aClientsDueOrOverdue / aClientsTotal) * 100) : 0;
    if (aOverduePct >= 50 && aClientsVeryOverdue === 0) {
      items.push({ text: `${aOverduePct}% of your A-clients are due or overdue for outreach`, urgent: true });
    }
    if (wtdReferralAsks === 0 && wdElapsed >= 3) {
      items.push({ text: `No referral asks logged this week — ${wdElapsed} days in with none`, urgent: true });
    } else if (wtdReferralAsks < 5 && wdElapsed >= 4) {
      items.push({ text: `${wtdReferralAsks}/5 referral asks this week — ${5 - wtdReferralAsks} more to hit goal`, urgent: false });
    }
    const agentPct = wtdOutbound > 0 ? Math.round((wtdAgents / wtdOutbound) * 100) : 0;
    if (agentPct < 30 && wtdOutbound >= 5) {
      items.push({ text: `Agent touches are ${agentPct}% of your outreach this week (target: 40%+)`, urgent: false });
    }
    if (wow <= -30 && out7Prev > 0) {
      items.push({ text: `Outreach dropped ${Math.abs(wow)}% this week vs last — ${out7} vs ${out7Prev} touches`, urgent: true });
    }
    const topSource = refSources[0];
    if (topSource && topSource.deals_closed === 0 && topSource.deals_total >= 2) {
      items.push({ text: `${topSource.display_name} has ${topSource.deals_total} deals in your pipeline but none closed yet`, urgent: false });
    }

    return items.slice(0, 5);
  }, [aClientsVeryOverdue, aClientsTotal, aClientsDueOrOverdue, wtdReferralAsks, wdElapsed, wtdAgents, wtdOutbound, wow, out7, out7Prev, refSources]);

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

    setContactsTotal(cs.length);
    setAgentsTotal(cs.filter(c => (c.category || "").toLowerCase() === "agent").length);
    setClientsTotal(cs.filter(c => (c.category || "").toLowerCase() === "client").length);

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

    // Referral source ROI — use pipeline_status (not legacy status)
    const pipelineRes = await fetch("/api/pipeline?include_closed=1");
    if (pipelineRes.ok) {
      const pj = await pipelineRes.json().catch(() => ({}));
      const allDeals: any[] = pj.deals ?? [];
      const sourceMap = new Map<string, RefSourceRow>();
      for (const d of allDeals) {
        const src = d.referral_source as any;
        if (!src?.id) continue;
        const existing = sourceMap.get(src.id) ?? { contact_id: src.id, display_name: src.display_name, deals_total: 0, deals_closed: 0, pipeline_value: 0, closed_value: 0 };
        existing.deals_total++;
        if (d.pipeline_status === "past_client") {
          existing.deals_closed++;
          existing.closed_value += d.price ?? 0;
        } else {
          existing.pipeline_value += d.price ?? d.budget_max ?? d.list_price ?? 0;
        }
        sourceMap.set(src.id, existing);
      }
      const sorted = [...sourceMap.values()].sort((a, b) => (b.closed_value + b.pipeline_value) - (a.closed_value + a.pipeline_value));
      setRefSources(sorted);
    }

    // Referral ask opportunities — also fix closed deal query
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
    if (typeof window !== "undefined") setDailyGoal(loadDailyGoal());
    let alive = true;
    const init = async () => {
      const { data } = await supabase.auth.getSession();
      if (!alive) return;
      if (!data.session) { window.location.href = "/login"; return; }
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

  // Weekly KPI targets (Jordan's model: 15 agent touches, 5 ref asks)
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

  return (
    <div className="stack">
      <div className="rowBetween">
        <div>
          <h1 className="h1">Accountability</h1>
          <div className="subtle" style={{ marginTop: 6 }}>
            {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </div>
        </div>
        <div className="row">
          <a className="btn" href="/morning" style={{ textDecoration: "none" }}>Morning</a>
          <a className="btn" href="/contacts" style={{ textDecoration: "none" }}>Contacts</a>
          <button className="btn" onClick={fetchAll}>Refresh</button>
        </div>
      </div>

      {error && <div className="alert alertError">{error}</div>}

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
          <div className="stack" style={{ gap: 8 }}>
            {quickInsights.map((ins, i) => (
              <div key={i} className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                <span style={{ fontSize: 13, flexShrink: 0 }}>{ins.urgent ? "⚠" : "→"}</span>
                <span style={{ fontSize: 13, fontWeight: ins.urgent ? 700 : 500, color: ins.urgent ? "#8a0000" : "var(--ink)" }}>
                  {ins.text}
                </span>
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
          <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 4 }}>Referral source ROI</div>
          <div className="subtle" style={{ fontSize: 12, marginBottom: 14 }}>Who's driving your deal flow — sorted by total value</div>
          <div className="stack" style={{ gap: 0 }}>
            {refSources.map((s, i) => (
              <div key={s.contact_id} style={{ padding: "10px 0", borderBottom: i < refSources.length - 1 ? "1px solid rgba(0,0,0,.05)" : undefined, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <a href={`/contacts/${s.contact_id}`} style={{ fontWeight: 800, fontSize: 14 }}>{s.display_name}</a>
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
                <div style={{ fontWeight: 900, fontSize: 18, flexShrink: 0, color: s.closed_value > 0 ? "#0b6b2a" : "var(--ink)" }}>
                  ${(s.closed_value + s.pipeline_value).toLocaleString()}
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
    </div>
  );
}
