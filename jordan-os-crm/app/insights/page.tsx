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

// ── Helpers ───────────────────────────────────────────────────────────────────

const RULES_KEY = "morning_rules_v1";

function loadDailyGoal(): number {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (!raw) return 5;
    return (JSON.parse(raw) as { totalRecs?: number })?.totalRecs ?? 5;
  } catch {
    return 5;
  }
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
  const day = x.getDay();
  x.setDate(x.getDate() - ((day + 6) % 7));
  return x;
}

function weekdaysElapsed(now = new Date()): number {
  const day = now.getDay();
  if (day === 0 || day === 6) return 5;
  return day; // Mon=1 … Fri=5
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

function pct(n: number, d: number): string {
  if (d <= 0) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

function deltaPct(curr: number, prev: number): number {
  if (prev <= 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function workdaysElapsedInMonth(d = new Date()): number {
  let count = 0;
  const cur = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d);
  end.setHours(23, 59, 59, 999);
  while (cur <= end) {
    const day = cur.getDay();
    if (day >= 1 && day <= 5) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function InsightsPage() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dailyGoal, setDailyGoal] = useState(5);

  // Rolling metrics
  const [out7, setOut7] = useState(0);
  const [out7Prev, setOut7Prev] = useState(0);
  const [out30, setOut30] = useState(0);
  const [agents7, setAgents7] = useState(0);
  const [clients7, setClients7] = useState(0);
  const [refAsks30, setRefAsks30] = useState(0);
  const [reviewAsks30, setReviewAsks30] = useState(0);

  // WTD
  const [wtdOutbound, setWtdOutbound] = useState(0);
  const [wtdAgents, setWtdAgents] = useState(0);
  const [wtdReferralAsks, setWtdReferralAsks] = useState(0);

  // MTD
  const [mtdOutbound, setMtdOutbound] = useState(0);
  const [mtdReferralAsks, setMtdReferralAsks] = useState(0);

  // Accountability
  const [todayCount, setTodayCount] = useState(0);
  const [streak, setStreak] = useState(0);
  const [touchesByDay, setTouchesByDay] = useState<Record<string, number>>({});
  const [weeklyHistory, setWeeklyHistory] = useState<WeekSummary[]>([]);
  const [avoidedContacts, setAvoidedContacts] = useState<AvoidedContact[]>([]);
  const [catCompliance, setCatCompliance] = useState<Record<string, CatCompliance>>({});

  // Referral source analytics
  type RefSourceRow = {
    contact_id: string;
    display_name: string;
    deals_total: number;
    deals_closed: number;
    pipeline_value: number;
    closed_value: number;
  };
  const [refSources, setRefSources] = useState<RefSourceRow[]>([]);

  // Referral pipeline
  type ReferralRow = {
    id: string;
    contact_id: string;
    occurred_at: string;
    summary: string | null;
    outcome: "pending" | "converted" | "closed" | null;
    contacts: { display_name: string; category: string; tier: string | null } | null;
  };
  const [referrals, setReferrals] = useState<ReferralRow[]>([]);
  const [refUpdating, setRefUpdating] = useState<string | null>(null);

  // Database health
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

  const mtdWorkdays = useMemo(() => workdaysElapsedInMonth(), [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const mtdGoal = useMemo(() => mtdWorkdays * dailyGoal, [mtdWorkdays, dailyGoal]);
  const mtdRefGoal = 4; // 4 referral asks per month
  const mtdOnPace = useMemo(() => mtdOutbound >= mtdGoal * 0.8, [mtdOutbound, mtdGoal]);

  const health = useMemo(() => {
    const aComp = aClientsTotal > 0
      ? clamp(Math.round(30 * (1 - aClientsDueOrOverdue / aClientsTotal)), 0, 30) : 30;
    const velocity = clamp(Math.round((out30 / (dailyGoal * 20)) * 25), 0, 25);
    const agentShare = out7 > 0 ? agents7 / out7 : 0;
    const agent = clamp(Math.round((agentShare / 0.4) * 20), 0, 20);
    const ask = clamp(Math.round((refAsks30 / 4) * 15), 0, 15);
    const growth = clamp(Math.round((contactsTotal / 200) * 10), 0, 10);
    return { total: aComp + velocity + agent + ask + growth, aComp, velocity, agent, ask, growth };
  }, [aClientsTotal, aClientsDueOrOverdue, out30, dailyGoal, out7, agents7, refAsks30, contactsTotal]);

  async function fetchAll() {
    setError(null);
    const now = new Date();
    const today = localDateStr(now);

    // ── 1. 35d touches ────────────────────────────────────────────────────────
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

    // Group by local date
    const byDay: Record<string, number> = {};
    for (const t of tAll) {
      const ds = localDateStr(new Date(t.occurred_at));
      byDay[ds] = (byDay[ds] ?? 0) + 1;
    }
    setTouchesByDay(byDay);
    setTodayCount(byDay[today] ?? 0);

    // Streak: consecutive weekdays that hit goal, including today if already done
    {
      let s = 0;
      const check = new Date(now);
      check.setHours(12, 0, 0, 0);
      for (let i = 0; i < 36; i++) {
        if (isWeekendDay(check)) { check.setDate(check.getDate() - 1); continue; }
        const ds = localDateStr(check);
        const isToday = ds === today;
        const count = byDay[ds] ?? 0;
        if (count >= dailyGoal) {
          s++;
          check.setDate(check.getDate() - 1);
        } else if (isToday) {
          // today not hit yet — doesn't break the streak, just skip to yesterday
          check.setDate(check.getDate() - 1);
        } else {
          break;
        }
      }
      setStreak(s);
    }

    // Time windows
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
    setReviewAsks30(t30.filter(t => t.intent === "review_ask").length);
    setWtdOutbound(tWtd.length);
    setWtdReferralAsks(tWtd.filter(t => t.intent === "referral_ask").length);

    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const tMtd = tAll.filter(t => new Date(t.occurred_at) >= startOfMonth);
    setMtdOutbound(tMtd.length);
    setMtdReferralAsks(tMtd.filter(t => t.intent === "referral_ask").length);

    // Weekly history (4 weeks)
    const weeks: WeekSummary[] = [];
    for (let w = 0; w < 4; w++) {
      const weekStart = startOfWeekMonday(now);
      weekStart.setDate(weekStart.getDate() - w * 7);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);

      const weekTouches = tAll.filter(t => {
        const d = new Date(t.occurred_at);
        return d >= weekStart && d < weekEnd;
      });

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
        agents: 0, // filled after contacts
        refAsks: weekTouches.filter(t => t.intent === "referral_ask").length,
        daysGoal: w === 0 ? weekdaysElapsed(now) * dailyGoal : 5 * dailyGoal,
        days,
      });
    }

    // ── 2. Contacts ───────────────────────────────────────────────────────────
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

    // Agent/client touch counts
    setAgents7(t7.filter(t => (catById.get(t.contact_id) || "").toLowerCase() === "agent").length);
    setClients7(t7.filter(t => (catById.get(t.contact_id) || "").toLowerCase() === "client").length);
    setWtdAgents(tWtd.filter(t => (catById.get(t.contact_id) || "").toLowerCase() === "agent").length);

    // Fill agent counts into weekly history
    for (const week of weeks) {
      const weekEnd = new Date(week.weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);
      week.agents = tAll.filter(t => {
        const d = new Date(t.occurred_at);
        return d >= week.weekStart && d < weekEnd && (catById.get(t.contact_id) || "").toLowerCase() === "agent";
      }).length;
    }
    setWeeklyHistory([...weeks]);

    // ── 3. Last outbound ──────────────────────────────────────────────────────
    const { data: loRaw, error: loErr } = await supabase
      .from("contact_last_outbound")
      .select("contact_id, last_outbound_at")
      .limit(20000);

    if (loErr) { setError(`LastOutbound fetch: ${loErr.message}`); return; }
    const loMap = new Map<string, string | null>();
    (loRaw ?? []).forEach((r: any) => loMap.set(r.contact_id, r.last_outbound_at));

    // A-client health
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

    // Avoided contacts: 2× past cadence, or never touched and older than cadence
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

    // Category compliance
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

    // ── 4. Referral source analytics ─────────────────────────────────────────
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
        if (d.status === "closed_won") { existing.deals_closed++; existing.closed_value += d.price ?? 0; }
        else { existing.pipeline_value += d.price ?? 0; }
        sourceMap.set(src.id, existing);
      }
      const sorted = [...sourceMap.values()].sort((a, b) => (b.closed_value + b.pipeline_value) - (a.closed_value + a.pipeline_value));
      setRefSources(sorted);
    }

    // ── 5. Referral pipeline ──────────────────────────────────────────────────
    const refRes = await fetch("/api/referrals");
    if (refRes.ok) {
      const rj = await refRes.json().catch(() => ({}));
      setReferrals((rj.referrals ?? []) as ReferralRow[]);
    }
  }

  async function updateOutcome(touchId: string, outcome: "pending" | "converted" | "closed") {
    setRefUpdating(touchId);
    await fetch("/api/referrals", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ touch_id: touchId, outcome }),
    });
    setReferrals((prev) => prev.map((r) => r.id === touchId ? { ...r, outcome } : r));
    setRefUpdating(null);
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

  return (
    <div className="stack">
      {/* Header */}
      <div className="rowBetween">
        <div>
          <h1 className="h1">Accountability</h1>
          <div className="subtle" style={{ marginTop: 6 }}>Outreach tracking • What's slipping • Category health</div>
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
        <div className="rowBetween" style={{ flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 13, textTransform: "uppercase", letterSpacing: 1, color: isOnPace ? "#0b6b2a" : "#8a0000" }}>
              {isOnPace ? "✓ On pace this week" : "⚠ Behind pace this week"}
            </div>
            <div className="subtle" style={{ marginTop: 4, fontSize: 13 }}>
              {wtdOutbound} outbound • goal: {wtdPace} ({wdElapsed} weekday{wdElapsed !== 1 ? "s" : ""} × {dailyGoal}/day)
            </div>
            {!isOnPace && wtdDeficit > 0 && (
              <div style={{ marginTop: 6, fontWeight: 700, color: "#8a0000", fontSize: 13 }}>
                {wtdDeficit} more touch{wtdDeficit !== 1 ? "es" : ""} needed to get back on pace
              </div>
            )}
            {aClientsVeryOverdue > 0 && (
              <div style={{ marginTop: 8, fontWeight: 700, color: "#8a0000", fontSize: 13 }}>
                ⚠ {aClientsVeryOverdue} A-client{aClientsVeryOverdue !== 1 ? "s" : ""} 14+ days past cadence — contact immediately
              </div>
            )}
          </div>

          <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 900, fontSize: 36, lineHeight: 1, color: todayDone ? "#0b6b2a" : "var(--ink)" }}>
                {todayCount}
              </div>
              <div className="subtle" style={{ fontSize: 11, marginTop: 3 }}>Today / {dailyGoal}</div>
              {todayDone && <div style={{ fontSize: 11, color: "#0b6b2a", fontWeight: 700 }}>✓ Goal hit</div>}
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 900, fontSize: 36, lineHeight: 1 }}>{wtdOutbound}</div>
              <div className="subtle" style={{ fontSize: 11, marginTop: 3 }}>This week</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 900, fontSize: 36, lineHeight: 1, color: streak > 0 ? "#0b6b2a" : "rgba(18,18,18,.3)" }}>
                {streak}
              </div>
              <div className="subtle" style={{ fontSize: 11, marginTop: 3 }}>Day streak</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 900, fontSize: 36, lineHeight: 1 }}>{health.total}</div>
              <div className="subtle" style={{ fontSize: 11, marginTop: 3 }}>Score / 100</div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Daily Log Grid ──────────────────────────────────────────────────── */}
      <div className="card cardPad">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 14 }}>Daily outreach log — last 4 weeks</div>
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
                  background: day.isFuture ? "transparent"
                    : hit ? "rgba(11,107,42,.12)"
                    : partial ? "rgba(170,110,0,.1)"
                    : missed ? "rgba(160,0,0,.07)"
                    : "rgba(0,0,0,.04)",
                  color: day.isFuture ? "rgba(18,18,18,.2)"
                    : hit ? "#0b6b2a"
                    : partial ? "rgba(130,80,0,.9)"
                    : missed ? "rgba(140,0,0,.65)"
                    : "rgba(18,18,18,.4)",
                  border: day.isToday ? "2px solid rgba(18,18,18,.3)" : "1px solid transparent",
                };

                return (
                  <div key={di} style={style}>
                    {day.isFuture ? "—" : day.count}
                  </div>
                );
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

      {/* ── WoW Bar Chart ───────────────────────────────────────────────────── */}
      {weeklyHistory.length > 0 && (() => {
        const weeks = [...weeklyHistory].reverse(); // oldest → newest
        const maxVal = Math.max(...weeks.map(w => w.outbound), dailyGoal * 5, 1);
        const BAR_H = 80;
        return (
          <div className="card cardPad">
            <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 14 }}>Week-over-week outreach</div>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
              {weeks.map((week, wi) => {
                const isCurrentWeek = wi === weeks.length - 1;
                const goalLine = week.daysGoal;
                const pct = Math.min(week.outbound / maxVal, 1);
                const goalPct = Math.min(goalLine / maxVal, 1);
                const onPace = week.outbound >= week.daysGoal * 0.8;
                const barColor = isCurrentWeek
                  ? (onPace ? "#0b6b2a" : "#8a0000")
                  : (onPace ? "rgba(11,107,42,.5)" : "rgba(140,0,0,.4)");
                return (
                  <div key={wi} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink)" }}>{week.outbound}</div>
                    <div style={{ position: "relative", width: "100%", height: BAR_H, background: "rgba(0,0,0,.05)", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: `${pct * 100}%`, background: barColor, borderRadius: "4px 4px 0 0", transition: "height .3s" }} />
                      {/* goal line */}
                      <div style={{ position: "absolute", left: 0, right: 0, bottom: `${goalPct * 100}%`, height: 1, background: "rgba(0,0,0,.25)" }} />
                    </div>
                    <div style={{ fontSize: 10, color: "rgba(18,18,18,.45)", textAlign: "center", whiteSpace: "nowrap" }}>
                      {isCurrentWeek ? "This wk" : week.label}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: "rgba(18,18,18,.4)" }}>
              Bars = total outreach • line = weekly goal • {" "}
              <span style={{ color: "#0b6b2a", fontWeight: 700 }}>■ On pace</span>{" "}
              <span style={{ color: "#8a0000", fontWeight: 700 }}>■ Behind</span>
            </div>
          </div>
        );
      })()}

      {/* ── Referral Source ROI ─────────────────────────────────────────────── */}
      {refSources.length > 0 && (
        <div className="card cardPad">
          <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 4 }}>Referral source ROI</div>
          <div className="subtle" style={{ fontSize: 12, marginBottom: 14 }}>Contacts who have sent you deal flow — sorted by total value</div>
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

      {/* ── Referral Pipeline ───────────────────────────────────────────────── */}
      <div className="card cardPad">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 4 }}>Referral pipeline</div>
        {(() => {
          const pending = referrals.filter(r => !r.outcome || r.outcome === "pending");
          const converted = referrals.filter(r => r.outcome === "converted");
          const closed = referrals.filter(r => r.outcome === "closed");
          return (
            <>
              <div className="row" style={{ gap: 20, marginBottom: 14, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13 }}><strong>{pending.length}</strong> <span className="subtle">pending</span></span>
                <span style={{ fontSize: 13, color: "#0b6b2a" }}><strong>{converted.length}</strong> <span style={{ color: "#0b6b2a", opacity: 0.7 }}>converted</span></span>
                <span style={{ fontSize: 13, color: "rgba(18,18,18,.4)" }}><strong>{closed.length}</strong> <span style={{ opacity: 0.7 }}>closed/no-go</span></span>
                {referrals.length > 0 && converted.length > 0 && (
                  <span style={{ fontSize: 13, fontWeight: 700 }}>
                    {Math.round(converted.length / referrals.length * 100)}% conversion
                  </span>
                )}
              </div>
              {referrals.length === 0 && (
                <div className="subtle" style={{ fontSize: 13 }}>No referral asks logged yet. Tag a touch with "referral ask" intent to start tracking.</div>
              )}
              {referrals.length > 0 && (
                <div className="stack" style={{ gap: 0 }}>
                  {referrals.slice(0, 20).map((r, i) => {
                    const outcome = r.outcome ?? "pending";
                    const name = (r.contacts as any)?.display_name ?? "Unknown";
                    const outcomeBadgeColor = outcome === "converted" ? "#0b6b2a" : outcome === "closed" ? "rgba(18,18,18,.35)" : "rgba(140,80,0,.8)";
                    return (
                      <div key={r.id} style={{ padding: "10px 0", borderBottom: i < Math.min(referrals.length, 20) - 1 ? "1px solid rgba(0,0,0,.05)" : undefined, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{name}</div>
                          <div style={{ fontSize: 11, color: "rgba(18,18,18,.45)", marginTop: 1 }}>
                            {new Date(r.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                            {r.summary ? ` · ${r.summary}` : ""}
                          </div>
                        </div>
                        <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                          {(["pending", "converted", "closed"] as const).map((o) => (
                            <button
                              key={o}
                              className="btn"
                              style={{
                                fontSize: 11,
                                padding: "2px 8px",
                                fontWeight: outcome === o ? 900 : 400,
                                background: outcome === o ? outcomeBadgeColor : undefined,
                                color: outcome === o ? "white" : undefined,
                                opacity: refUpdating === r.id ? 0.5 : 1,
                              }}
                              onClick={() => updateOutcome(r.id, o)}
                              disabled={refUpdating === r.id || outcome === o}
                            >
                              {o}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          );
        })()}
      </div>

      {/* ── Weekly Summary Table ────────────────────────────────────────────── */}
      <div className="card cardPad">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 14 }}>Weekly summary</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid rgba(0,0,0,.08)" }}>
                {["Week of", "Outreach", "Goal", "vs Goal", "Agent touches", "Ref asks"].map(h => (
                  <th key={h} style={{ padding: "4px 12px", textAlign: h === "Week of" ? "left" : "center", fontWeight: 700, color: "rgba(18,18,18,.5)", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weeklyHistory.map((week, wi) => {
                const diff = week.outbound - week.daysGoal;
                const onPace = week.outbound >= week.daysGoal * 0.8;
                return (
                  <tr key={wi} style={{ borderBottom: "1px solid rgba(0,0,0,.05)" }}>
                    <td style={{ padding: "9px 12px", fontWeight: wi === 0 ? 800 : 400 }}>
                      {wi === 0 ? "This week" : week.label}
                    </td>
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

      {/* ── Avoided Contacts ────────────────────────────────────────────────── */}
      {avoidedContacts.length > 0 && (
        <div className="card cardPad stack">
          <div>
            <div style={{ fontWeight: 900, fontSize: 15 }}>
              Contacts slipping — {avoidedContacts.length} need attention
            </div>
            <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>
              These contacts are 2× past their cadence or never been touched. You're avoiding them.
            </div>
          </div>
          <div className="stack" style={{ gap: 0 }}>
            {avoidedContacts.map((c, i) => (
              <div
                key={c.id}
                className="rowBetween"
                style={{ padding: "10px 0", borderBottom: i < avoidedContacts.length - 1 ? "1px solid rgba(0,0,0,.06)" : undefined, alignItems: "center", gap: 12 }}
              >
                <div style={{ minWidth: 0 }}>
                  <div className="row" style={{ alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                    <a href={`/contacts/${c.id}`} style={{ fontWeight: 800, wordBreak: "break-word" }}>{c.display_name}</a>
                    <span className="subtle" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                      {c.category}{c.tier ? ` • Tier ${c.tier}` : ""}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "#8a0000", marginTop: 2 }}>
                    {c.days === null
                      ? `Never touched — in system ${c.overdueBy}d, cadence is ${c.cadence}d`
                      : `${c.days}d since last outbound — ${c.overdueBy}d past cadence (${c.cadence}d)`}
                  </div>
                </div>
                <a className="btn" href={`/contacts/${c.id}`} style={{ textDecoration: "none", whiteSpace: "nowrap", fontSize: 12, flexShrink: 0 }}>
                  Open →
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {avoidedContacts.length === 0 && (
        <div className="card cardPad">
          <div style={{ fontWeight: 900, fontSize: 15 }}>Contacts slipping</div>
          <div className="subtle" style={{ marginTop: 6 }}>✓ No contacts 2× past their cadence — clean slate.</div>
        </div>
      )}

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
                    <span style={{ fontSize: 13, fontWeight: 700, color }}>
                      {stat.onCadence}/{stat.total} on cadence ({pctVal}%)
                    </span>
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

      {/* ── WTD + MTD Pace ──────────────────────────────────────────────────── */}
      <div className="card cardPad">
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 10 }}>Week-to-date pace</div>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <span
            className="badge"
            style={{
              borderColor: isOnPace ? "rgba(11,107,42,.3)" : "rgba(200,0,0,.25)",
              background: isOnPace ? "rgba(11,107,42,.07)" : "rgba(200,0,0,.05)",
              color: isOnPace ? "#0b6b2a" : "#8a0000",
              fontWeight: 700,
            }}
          >
            WTD outreach: {wtdOutbound} / {wtdPace} pace
          </span>
          <span className="badge">Agents: {wtdAgents} / {wdElapsed * 2} pace</span>
          <span className="badge">Ref asks this week: {wtdReferralAsks} / 1</span>
          <span className="badge">WoW: {wow >= 0 ? `+${wow}%` : `${wow}%`}</span>
          {aClientsDueOrOverdue > 0 && (
            <span className="badge" style={{ borderColor: "rgba(200,0,0,.25)", background: "rgba(200,0,0,.05)", color: "#8a0000", fontWeight: 700 }}>
              {aClientsDueOrOverdue}/{aClientsTotal} A-clients overdue
            </span>
          )}
        </div>
        <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 10, marginTop: 18 }}>Month-to-date pace</div>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <span
            className="badge"
            style={{
              borderColor: mtdOnPace ? "rgba(11,107,42,.3)" : "rgba(200,0,0,.25)",
              background: mtdOnPace ? "rgba(11,107,42,.07)" : "rgba(200,0,0,.05)",
              color: mtdOnPace ? "#0b6b2a" : "#8a0000",
              fontWeight: 700,
            }}
          >
            MTD outreach: {mtdOutbound} / {mtdGoal} pace ({mtdWorkdays}d × {dailyGoal})
          </span>
          <span
            className="badge"
            style={{
              borderColor: mtdReferralAsks >= mtdRefGoal ? "rgba(11,107,42,.3)" : undefined,
              background: mtdReferralAsks >= mtdRefGoal ? "rgba(11,107,42,.07)" : undefined,
              color: mtdReferralAsks >= mtdRefGoal ? "#0b6b2a" : undefined,
              fontWeight: mtdReferralAsks >= mtdRefGoal ? 700 : 400,
            }}
          >
            Ref asks this month: {mtdReferralAsks} / {mtdRefGoal}{mtdReferralAsks >= mtdRefGoal ? " ✓" : ""}
          </span>
        </div>
      </div>

      {/* ── Metrics (secondary) ─────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        <div className="card cardPad">
          <div className="label">Score breakdown</div>
          <div style={{ fontWeight: 900, fontSize: 26, marginTop: 4 }}>{health.total}<span className="subtle" style={{ fontSize: 13, fontWeight: 400 }}>/100</span></div>
          <div className="stack" style={{ gap: 6, marginTop: 10 }}>
            {([
              { label: "A-client compliance", value: health.aComp, max: 30 },
              { label: "Outreach velocity", value: health.velocity, max: 25 },
              { label: "Agent share", value: health.agent, max: 20 },
              { label: "Ask activity", value: health.ask, max: 15 },
              { label: "Database size", value: health.growth, max: 10 },
            ] as Array<{ label: string; value: number; max: number }>).map(({ label, value, max }) => {
              const ratio = max > 0 ? value / max : 0;
              const color = ratio >= 0.8 ? "#0b6b2a" : ratio >= 0.5 ? "rgba(130,80,0,.9)" : "#8a0000";
              return (
                <div key={label}>
                  <div className="rowBetween" style={{ marginBottom: 3 }}>
                    <span style={{ fontSize: 11, color: "rgba(18,18,18,.55)" }}>{label}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color }}>{value}/{max}</span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: "rgba(0,0,0,.08)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.round(ratio * 100)}%`, background: color, borderRadius: 2 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="card cardPad">
          <div className="label">Velocity</div>
          <div style={{ fontWeight: 900, fontSize: 22, marginTop: 4 }}>{out30}<span className="subtle" style={{ fontSize: 12, fontWeight: 400 }}> (30d)</span></div>
          <div className="subtle" style={{ fontSize: 12 }}>7d: {out7} • prior 7d: {out7Prev} • WoW {wow >= 0 ? "+" : ""}{wow}%</div>
        </div>
        <div className="card cardPad">
          <div className="label">Mix (7d)</div>
          <div style={{ fontWeight: 900, fontSize: 18, marginTop: 4 }}>{agents7} agents • {clients7} clients</div>
          <div className="subtle" style={{ fontSize: 12 }}>of {out7} outbound • {pct(agents7, out7)} agent share</div>
        </div>
        <div className="card cardPad">
          <div className="label">Asks (30d)</div>
          <div style={{ fontWeight: 900, fontSize: 18, marginTop: 4 }}>{refAsks30} referral • {reviewAsks30} review</div>
          <div className="subtle" style={{ fontSize: 12 }}>Tagged via touch intent</div>
        </div>
        <div className="card cardPad">
          <div className="label">Database</div>
          <div style={{ fontWeight: 900, fontSize: 18, marginTop: 4 }}>{contactsTotal} contacts</div>
          <div className="subtle" style={{ fontSize: 12 }}>{agentsTotal} agents • {clientsTotal} clients • {aClientsTotal} A-clients</div>
        </div>
      </div>
    </div>
  );
}
