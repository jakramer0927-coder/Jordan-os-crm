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
  channel: string | null;
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

// ── Component ─────────────────────────────────────────────────────────────────

export default function InsightsPage() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dailyGoal, setDailyGoal] = useState(5);

  // Channel breakdown (7d)
  const [channelBreakdown7, setChannelBreakdown7] = useState<Record<string, number>>({});

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

  // Accountability
  const [todayCount, setTodayCount] = useState(0);
  const [streak, setStreak] = useState(0);
  const [touchesByDay, setTouchesByDay] = useState<Record<string, number>>({});
  const [weeklyHistory, setWeeklyHistory] = useState<WeekSummary[]>([]);
  const [avoidedContacts, setAvoidedContacts] = useState<AvoidedContact[]>([]);
  const [catCompliance, setCatCompliance] = useState<Record<string, CatCompliance>>({});

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

  const healthScore = useMemo(() => {
    const aComp = aClientsTotal > 0
      ? clamp(Math.round(30 * (1 - aClientsDueOrOverdue / aClientsTotal)), 0, 30) : 30;
    const velocity = clamp(Math.round((out30 / (dailyGoal * 20)) * 25), 0, 25);
    const agentShare = out7 > 0 ? agents7 / out7 : 0;
    const agent = clamp(Math.round((agentShare / 0.4) * 20), 0, 20);
    const ask = clamp(Math.round((refAsks30 / 4) * 15), 0, 15);
    const growth = clamp(Math.round((contactsTotal / 200) * 10), 0, 10);
    return aComp + velocity + agent + ask + growth;
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
      .select("id, contact_id, direction, occurred_at, intent, channel")
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

    // Streak: consecutive past weekdays that hit goal
    {
      let s = 0;
      const check = new Date(now);
      check.setHours(12, 0, 0, 0);
      check.setDate(check.getDate() - 1);
      for (let i = 0; i < 35; i++) {
        if (isWeekendDay(check)) { check.setDate(check.getDate() - 1); continue; }
        const ds = localDateStr(check);
        if ((byDay[ds] ?? 0) >= dailyGoal) { s++; check.setDate(check.getDate() - 1); }
        else break;
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

    // Channel breakdown for last 7 days
    const chBreak: Record<string, number> = {};
    for (const t of t7) {
      const ch = t.channel || "other";
      chBreak[ch] = (chBreak[ch] ?? 0) + 1;
    }
    setChannelBreakdown7(chBreak);
    setOut30(t30.length);
    setRefAsks30(t30.filter(t => t.intent === "referral_ask").length);
    setReviewAsks30(t30.filter(t => t.intent === "review_ask").length);
    setWtdOutbound(tWtd.length);
    setWtdReferralAsks(tWtd.filter(t => t.intent === "referral_ask").length);

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
              <div style={{ fontWeight: 900, fontSize: 36, lineHeight: 1 }}>{healthScore}</div>
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

      {/* ── WTD Pace ────────────────────────────────────────────────────────── */}
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
            Outreach: {wtdOutbound} / {wtdPace} pace
          </span>
          <span className="badge">Agents: {wtdAgents} / {wdElapsed * 2} pace</span>
          <span className="badge">Ref asks: {wtdReferralAsks} / 1 weekly</span>
          <span className="badge">WoW: {wow >= 0 ? `+${wow}%` : `${wow}%`}</span>
          {aClientsDueOrOverdue > 0 && (
            <span className="badge" style={{ borderColor: "rgba(200,0,0,.25)", background: "rgba(200,0,0,.05)", color: "#8a0000", fontWeight: 700 }}>
              {aClientsDueOrOverdue}/{aClientsTotal} A-clients overdue
            </span>
          )}
        </div>
      </div>

      {/* ── Metrics (secondary) ─────────────────────────────────────────────── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 }}>
        <div className="card cardPad">
          <div className="label">Score</div>
          <div style={{ fontWeight: 900, fontSize: 26, marginTop: 4 }}>{healthScore}<span className="subtle" style={{ fontSize: 13, fontWeight: 400 }}>/100</span></div>
          <div className="subtle" style={{ fontSize: 12 }}>Compliance + velocity + asks</div>
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
          {Object.keys(channelBreakdown7).length > 0 && (
            <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {Object.entries(channelBreakdown7)
                .sort((a, b) => b[1] - a[1])
                .map(([ch, n]) => (
                  <span key={ch} className="badge" style={{ fontSize: 11 }}>
                    {ch}: {n}
                  </span>
                ))}
            </div>
          )}
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
