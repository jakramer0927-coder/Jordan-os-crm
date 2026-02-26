"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";

type TouchIntent =
  | "check_in"
  | "referral_ask"
  | "review_ask"
  | "deal_followup"
  | "collaboration"
  | "event_invite"
  | "other";

type Contact = {
  id: string;
  display_name: string;
  category: string; // Client, Agent, Developer, ...
  tier: string | null; // A/B/C
};

type Touch = {
  id: string;
  contact_id: string;
  direction: "outbound" | "inbound";
  occurred_at: string;
  intent: TouchIntent | null;
};

type ContactLastOutboundRow = {
  contact_id: string;
  last_outbound_at: string | null;
};

type Intervention = {
  key: string;
  priority: number; // higher = more urgent
  title: string;
  summary: string;
  target: string;
  suggested: Array<{
    contact_id: string;
    display_name: string;
    category: string;
    tier: string | null;
    days_since_outbound: number | null;
    why: string;
  }>;
};

function pct(n: number, d: number) {
  if (d <= 0) return "—";
  return `${Math.round((n / d) * 100)}%`;
}

function deltaPct(curr: number, prev: number) {
  if (prev <= 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function daysSince(iso: string) {
  const then = new Date(iso).getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - then) / (1000 * 60 * 60 * 24)));
}

function cadenceDays(categoryRaw: string, tierRaw: string | null): number {
  const category = (categoryRaw || "").toLowerCase();
  const tier = (tierRaw || "").toUpperCase();

  if (category === "client") {
    if (tier === "A") return 30;
    if (tier === "B") return 60;
    return 90;
  }
  if (category === "agent") {
    if (tier === "A") return 30;
    if (tier === "B") return 60;
    return 90;
  }
  if (category === "developer") return 60;

  if (tier === "A") return 45;
  if (tier === "B") return 75;
  return 120;
}

// Local start-of-day
function startOfDayLocal(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// Monday 00:00 local for current week
function startOfWeekMondayLocal(now = new Date()) {
  const d = startOfDayLocal(now);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const diffToMonday = (day + 6) % 7; // Mon ->0, Tue->1, Sun->6
  d.setDate(d.getDate() - diffToMonday);
  return d;
}

// Count weekdays from Monday..today inclusive if today is weekday, else through Friday
function weekdaysElapsedThisWeek(now = new Date()) {
  const day = now.getDay(); // 0 Sun..6 Sat
  if (day === 0) return 5; // Sun -> treat as week done (Fri)
  if (day === 6) return 5; // Sat -> treat as week done (Fri)
  // Mon=1 ->1, Tue=2 ->2 ... Fri=5 ->5
  return day;
}

function isThursdayOrLater(now = new Date()) {
  const day = now.getDay(); // Thu=4, Fri=5
  return day >= 4 && day <= 6;
}

function categoryPretty(c: string) {
  const s = (c || "").trim();
  if (!s) return "Other";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export default function InsightsPage() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Touch metrics
  const [out7, setOut7] = useState(0);
  const [out30, setOut30] = useState(0);
  const [out7Prev, setOut7Prev] = useState(0);
  const [agents7, setAgents7] = useState(0);
  const [clients7, setClients7] = useState(0);

  const [refAsks30, setRefAsks30] = useState(0);
  const [reviewAsks30, setReviewAsks30] = useState(0);

  // Week-to-date coach metrics
  const [wtdOutbound, setWtdOutbound] = useState(0);
  const [wtdAgents, setWtdAgents] = useState(0);
  const [wtdReferralAsks, setWtdReferralAsks] = useState(0);

  // Database health
  const [contactsTotal, setContactsTotal] = useState(0);
  const [agentsTotal, setAgentsTotal] = useState(0);
  const [clientsTotal, setClientsTotal] = useState(0);

  const [aClientsTotal, setAClientsTotal] = useState(0);
  const [aClientsDueOrOverdue, setAClientsDueOrOverdue] = useState(0);
  const [aClientsVeryOverdue, setAClientsVeryOverdue] = useState(0); // > cadence + 14 days

  const [loadedHealth, setLoadedHealth] = useState(false);

  // We keep some computed contact context for interventions
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [lastOutboundById, setLastOutboundById] = useState<Map<string, string | null>>(new Map());

  const now = useMemo(() => new Date(), []);
  const wow = useMemo(() => deltaPct(out7, out7Prev), [out7, out7Prev]);

  const weekdaysElapsed = useMemo(() => weekdaysElapsedThisWeek(new Date()), [wtdOutbound, wtdAgents, wtdReferralAsks]);
  const expectedOutboundWTD = useMemo(() => weekdaysElapsed * 5, [weekdaysElapsed]);
  const expectedAgentsWTD = useMemo(() => weekdaysElapsed * 2, [weekdaysElapsed]);

  const healthScore = useMemo(() => {
    // Score 0..100
    // 30% A-client compliance, 25% velocity consistency, 20% agent leverage, 15% ask discipline, 10% database growth (placeholder)
    // We keep it simple + stable for now.
    const aComp =
      aClientsTotal > 0
        ? clamp(Math.round(30 * (1 - aClientsDueOrOverdue / aClientsTotal)), 0, 30)
        : 30;

    const velocity = clamp(Math.round((out30 / 120) * 25), 0, 25); // rough: 120 outbound / 30d => full

    const agentShare = out7 > 0 ? agents7 / out7 : 0;
    const agent = clamp(Math.round((agentShare / 0.4) * 20), 0, 20); // 40% => full

    const asks = refAsks30; // primary focus
    const ask = clamp(Math.round((asks / 4) * 15), 0, 15); // 1/wk => ~4/mo full

    const growth = clamp(Math.round((contactsTotal / 200) * 10), 0, 10);

    return aComp + velocity + agent + ask + growth;
  }, [aClientsTotal, aClientsDueOrOverdue, out30, out7, agents7, refAsks30, contactsTotal]);

  const warnings = useMemo(() => {
    const items: Array<{ title: string; detail: string }> = [];

    if (out7Prev >= 5 && wow <= -20) {
      items.push({
        title: "Outreach declining",
        detail: `Outbound touches are down ${Math.abs(wow)}% vs the prior 7 days.`,
      });
    }

    if (out7 >= 5) {
      const agentPct = agents7 / out7;
      if (agentPct < 0.25) {
        items.push({
          title: "Agent outreach low",
          detail: `Only ${pct(agents7, out7)} of outbound touches were to agents in the last 7 days.`,
        });
      }
    }

    if (aClientsTotal > 0) {
      const overduePct = aClientsDueOrOverdue / aClientsTotal;
      if (overduePct >= 0.15) {
        items.push({
          title: "A-Client risk",
          detail: `${aClientsDueOrOverdue}/${aClientsTotal} A-clients are due/overdue on outbound cadence.`,
        });
      }
      if (aClientsVeryOverdue > 0) {
        items.push({
          title: "A-Client very overdue",
          detail: `${aClientsVeryOverdue} A-client(s) are >14 days beyond cadence.`,
        });
      }
    }

    if (refAsks30 + reviewAsks30 === 0) {
      items.push({
        title: "No referral/review asks tracked (30 days)",
        detail: "Tag at least 1 touch per week as referral_ask so Jordan OS can coach the behavior.",
      });
    }

    return items;
  }, [wow, out7Prev, out7, agents7, aClientsTotal, aClientsDueOrOverdue, aClientsVeryOverdue, refAsks30, reviewAsks30]);

  const interventions: Intervention[] = useMemo(() => {
    // Build top 2 interventions based on your “Active Coach” rules:
    // - Weekday-only cadence targets; weekly aggregate
    // - Referral ask minimum 1 per week (warning Thurs+ if 0)
    // - A-client risk: due/overdue and “very overdue” > cadence+14
    // - Agent leverage: target 2/weekday

    const list: Intervention[] = [];

    // Helper: suggest contacts by category (and optionally tier), sorted by "most overdue"
    const suggest = (opts: { category?: string; tier?: string; limit?: number; onlyDue?: boolean }) => {
      const limit = opts.limit ?? 3;
      const cat = (opts.category || "").toLowerCase();
      const tier = (opts.tier || "").toUpperCase();

      const candidates = contacts
        .filter((c) => {
          if (cat && (c.category || "").toLowerCase() !== cat) return false;
          if (tier && (c.tier || "").toUpperCase() !== tier) return false;
          return true;
        })
        .map((c) => {
          const last = lastOutboundById.get(c.id) ?? null;
          const days = last ? daysSince(last) : null;
          const cadence = cadenceDays(c.category, c.tier);
          const isDue = days === null ? true : days >= cadence;
          const overdueBy = days === null ? cadence + 1 : days - cadence;
          return { c, days, cadence, isDue, overdueBy };
        })
        .filter((x) => (opts.onlyDue ? x.isDue : true))
        .sort((a, b) => {
          // null last => treat as most urgent
          const ao = a.days === null ? 9999 : a.overdueBy;
          const bo = b.days === null ? 9999 : b.overdueBy;
          return bo - ao;
        })
        .slice(0, limit)
        .map((x) => ({
          contact_id: x.c.id,
          display_name: x.c.display_name,
          category: x.c.category,
          tier: x.c.tier,
          days_since_outbound: x.days,
          why:
            x.days === null
              ? `No outbound touch logged (cadence ${x.cadence}d)`
              : `${x.days}d since outbound (cadence ${x.cadence}d)`,
        }));

      return candidates;
    };

    // A-client protection intervention
    if (aClientsVeryOverdue > 0 || (aClientsTotal > 0 && aClientsDueOrOverdue / aClientsTotal >= 0.15)) {
      const pr = aClientsVeryOverdue > 0 ? 100 : 85;
      const suggested = suggest({ category: "client", tier: "A", limit: 5, onlyDue: true });

      list.push({
        key: "a_client_risk",
        priority: pr,
        title: aClientsVeryOverdue > 0 ? "A-Client protection: urgent" : "A-Client protection: tighten cadence",
        summary:
          aClientsVeryOverdue > 0
            ? `${aClientsVeryOverdue} A-client(s) are >14 days beyond cadence.`
            : `${aClientsDueOrOverdue}/${aClientsTotal} A-clients are due/overdue.`,
        target: "Clear overdue A-clients first (they stay pinned until touched).",
        suggested,
      });
    }

    // Weekly velocity pacing intervention (weekday-only, weekly aggregate)
    const paceRatio = expectedOutboundWTD > 0 ? wtdOutbound / expectedOutboundWTD : 1;
    if (expectedOutboundWTD > 0 && paceRatio < 0.8) {
      const deficit = expectedOutboundWTD - wtdOutbound;
      const suggested = suggest({ limit: 5 }); // any category, most overdue-ish
      list.push({
        key: "weekly_velocity",
        priority: 75,
        title: "Weekly velocity at risk",
        summary: `Week-to-date outbound: ${wtdOutbound}/${expectedOutboundWTD} (behind by ${deficit}).`,
        target: `Get back on pace: add ${Math.max(0, deficit)} outbound touches this week.`,
        suggested,
      });
    }

    // Agent leverage pacing intervention
    const agentPaceRatio = expectedAgentsWTD > 0 ? wtdAgents / expectedAgentsWTD : 1;
    if (expectedAgentsWTD > 0 && agentPaceRatio < 0.8) {
      const deficit = expectedAgentsWTD - wtdAgents;
      const suggested = suggest({ category: "agent", limit: 5, onlyDue: false });
      list.push({
        key: "agent_leverage",
        priority: 70,
        title: "Agent leverage drifting",
        summary: `Week-to-date agent touches: ${wtdAgents}/${expectedAgentsWTD} (need ${Math.max(0, deficit)} more).`,
        target: `Hit your network leverage: add ${Math.max(0, deficit)} agent touches this week.`,
        suggested,
      });
    }

    // Referral ask discipline intervention (minimum 1/wk) — only start nagging Thurs+
    if (isThursdayOrLater(new Date()) && wtdReferralAsks === 0) {
      const suggested = suggest({ category: "client", tier: "A", limit: 3, onlyDue: false }).concat(
        suggest({ category: "client", tier: "B", limit: 2, onlyDue: false })
      ).slice(0, 5);

      list.push({
        key: "referral_ask",
        priority: 65,
        title: "Referral ask missing this week",
        summary: "0 touches tagged as referral_ask since Monday.",
        target: "Tag at least 1 touch as referral_ask this week (minimum discipline).",
        suggested,
      });
    }

    // If nothing triggers, still provide a “keep winning” intervention (low priority)
    if (list.length === 0) {
      list.push({
        key: "no_intervention",
        priority: 1,
        title: "No intervention needed",
        summary: "You’re on pace and your risk indicators are clean.",
        target: "Keep running the Morning Top 5 and tag at least 1 referral ask this week.",
        suggested: suggest({ limit: 3 }),
      });
    }

    // Return top 2 by priority
    return list.sort((a, b) => b.priority - a.priority).slice(0, 2);
  }, [
    contacts,
    lastOutboundById,
    aClientsTotal,
    aClientsDueOrOverdue,
    aClientsVeryOverdue,
    expectedOutboundWTD,
    expectedAgentsWTD,
    wtdOutbound,
    wtdAgents,
    wtdReferralAsks,
  ]);

  async function fetchTouchCounts() {
    setError(null);

    const now = new Date();
    const since7 = new Date(now);
    since7.setDate(since7.getDate() - 7);
    since7.setHours(0, 0, 0, 0);

    const since14 = new Date(now);
    since14.setDate(since14.getDate() - 14);
    since14.setHours(0, 0, 0, 0);

    const since30 = new Date(now);
    since30.setDate(since30.getDate() - 30);
    since30.setHours(0, 0, 0, 0);

    const { data: t14, error: e14 } = await supabase
      .from("touches")
      .select("id, contact_id, direction, occurred_at, intent")
      .eq("direction", "outbound")
      .gte("occurred_at", since14.toISOString())
      .order("occurred_at", { ascending: false })
      .limit(20000);

    if (e14) {
      setError(`Touches (14d) fetch error: ${e14.message}`);
      return;
    }

    const touches14 = (t14 ?? []) as Touch[];
    const now7 = touches14.filter((t) => t.occurred_at >= since7.toISOString());
    const prev7 = touches14.filter((t) => t.occurred_at < since7.toISOString());

    setOut7(now7.length);
    setOut7Prev(prev7.length);

    const { count: c30, error: e30 } = await supabase
      .from("touches")
      .select("id", { count: "exact", head: true })
      .eq("direction", "outbound")
      .gte("occurred_at", since30.toISOString());

    if (e30) setError((prev) => prev ?? `Touches (30d) count error: ${e30.message}`);
    else setOut30(c30 ?? 0);

    const { data: t30, error: e30i } = await supabase
      .from("touches")
      .select("id, intent, occurred_at, direction, contact_id")
      .eq("direction", "outbound")
      .gte("occurred_at", since30.toISOString())
      .limit(20000);

    if (e30i) {
      setError((prev) => prev ?? `Touches (30d) intent fetch error: ${e30i.message}`);
    } else {
      const rows = (t30 ?? []) as Touch[];
      setRefAsks30(rows.filter((r) => r.intent === "referral_ask").length);
      setReviewAsks30(rows.filter((r) => r.intent === "review_ask").length);
    }

    // Agent vs Client split for last 7 days
    const touchedIds7 = Array.from(new Set(now7.map((t) => t.contact_id)));
    if (touchedIds7.length === 0) {
      setAgents7(0);
      setClients7(0);
    } else {
      const { data: c7, error: ec7 } = await supabase.from("contacts").select("id, category").in("id", touchedIds7);
      if (ec7) setError((prev) => prev ?? `Contacts (7d categories) error: ${ec7.message}`);
      else {
        const catById = new Map<string, string>();
        (c7 ?? []).forEach((r: any) => catById.set(r.id, r.category));
        let agents = 0;
        let clients = 0;
        for (const t of now7) {
          const cat = (catById.get(t.contact_id) || "").toLowerCase();
          if (cat === "agent") agents += 1;
          else if (cat === "client") clients += 1;
        }
        setAgents7(agents);
        setClients7(clients);
      }
    }

    // Week-to-date coach metrics
    const monday = startOfWeekMondayLocal(new Date());
    const mondayISO = monday.toISOString();

    const { data: wtd, error: ewtd } = await supabase
      .from("touches")
      .select("id, contact_id, occurred_at, direction, intent")
      .eq("direction", "outbound")
      .gte("occurred_at", mondayISO)
      .limit(20000);

    if (ewtd) {
      setError((prev) => prev ?? `WTD metrics error: ${ewtd.message}`);
    } else {
      const wtdTouches = (wtd ?? []) as Touch[];
      setWtdOutbound(wtdTouches.length);
      setWtdReferralAsks(wtdTouches.filter((t) => t.intent === "referral_ask").length);

      const ids = Array.from(new Set(wtdTouches.map((t) => t.contact_id)));
      if (ids.length === 0) {
        setWtdAgents(0);
      } else {
        const { data: cc, error: ecc } = await supabase.from("contacts").select("id, category").in("id", ids);
        if (ecc) {
          setError((prev) => prev ?? `WTD agent count error: ${ecc.message}`);
        } else {
          const catById = new Map<string, string>();
          (cc ?? []).forEach((r: any) => catById.set(r.id, r.category));
          let agentCount = 0;
          for (const t of wtdTouches) {
            if ((catById.get(t.contact_id) || "").toLowerCase() === "agent") agentCount += 1;
          }
          setWtdAgents(agentCount);
        }
      }
    }
  }

  async function fetchDatabaseHealth() {
    setError(null);
    setLoadedHealth(false);

    const { data: cData, error: cErr } = await supabase.from("contacts").select("id, display_name, category, tier").limit(20000);

    if (cErr) {
      setError(`Contacts fetch error: ${cErr.message}`);
      return;
    }

    const cs = (cData ?? []) as Contact[];
    setContacts(cs);
    setContactsTotal(cs.length);

    const agents = cs.filter((c) => (c.category || "").toLowerCase() === "agent").length;
    const clients = cs.filter((c) => (c.category || "").toLowerCase() === "client").length;
    setAgentsTotal(agents);
    setClientsTotal(clients);

    const aClients = cs.filter(
      (c) => (c.category || "").toLowerCase() === "client" && (c.tier || "").toUpperCase() === "A"
    );
    setAClientsTotal(aClients.length);

    const { data: vData, error: vErr } = await supabase
      .from("contact_last_outbound")
      .select("contact_id, last_outbound_at")
      .limit(20000);

    if (vErr) {
      setError((prev) => prev ?? `View contact_last_outbound error: ${vErr.message}`);
      return;
    }

    const map = new Map<string, string | null>();
    (vData ?? []).forEach((r: any) => map.set(r.contact_id, r.last_outbound_at));
    setLastOutboundById(map);

    let dueOrOverdue = 0;
    let veryOverdue = 0;

    for (const c of aClients) {
      const last = map.get(c.id) ?? null;
      const cadence = cadenceDays(c.category, c.tier);

      if (!last) {
        // treat "never touched" as overdue; also treat as "very overdue" once you have enough data
        dueOrOverdue += 1;
        continue;
      }

      const d = daysSince(last);
      if (d >= cadence) {
        dueOrOverdue += 1;
        if (d >= cadence + 14) veryOverdue += 1;
      }
    }

    setAClientsDueOrOverdue(dueOrOverdue);
    setAClientsVeryOverdue(veryOverdue);

    setLoadedHealth(true);
  }

  async function refreshAll() {
    await Promise.all([fetchTouchCounts(), fetchDatabaseHealth()]);
  }

  useEffect(() => {
    let alive = true;

    const init = async () => {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user.id ?? null;

      if (!alive) return;

      if (!uid) {
        setTimeout(async () => {
          const { data: d2 } = await supabase.auth.getSession();
          if (!d2.session) window.location.href = "/login";
        }, 250);
        return;
      }

      setReady(true);
      await refreshAll();
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const uid = session?.user.id ?? null;
      if (!uid) window.location.href = "/login";
    });

    init();

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (!ready) return <div style={{ padding: 40 }}>Loading…</div>;

  return (
    <div style={{ padding: 40, maxWidth: 1100 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0 }}>Insights</h1>
          <div style={{ marginTop: 6, color: "#666" }}>Velocity • Asks • Database health • Active Coach</div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <a
            href="/morning"
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              textDecoration: "none",
              color: "#111",
            }}
          >
            Morning
          </a>
          <a
            href="/contacts"
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              textDecoration: "none",
              color: "#111",
            }}
          >
            Contacts
          </a>
          <button
            onClick={refreshAll}
            style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
          >
            Refresh
          </button>
        </div>
      </div>

      {error && <div style={{ marginTop: 14, color: "crimson", fontWeight: 800 }}>{error}</div>}

      {/* Summary cards */}
      <div
        style={{
          marginTop: 18,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: 12,
        }}
      >
        <div style={{ border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
          <div style={{ fontSize: 12, color: "#999" }}>Operator score</div>
          <div style={{ fontSize: 34, fontWeight: 900, marginTop: 6 }}>{healthScore}</div>
          <div style={{ color: "#666", marginTop: 4 }}>0–100 (compliance + velocity + leverage + asks)</div>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
          <div style={{ fontSize: 12, color: "#999" }}>Outbound velocity</div>
          <div style={{ fontSize: 22, fontWeight: 900, marginTop: 6 }}>
            {out7} (7d) • {out30} (30d)
          </div>
          <div style={{ color: "#666", marginTop: 4 }}>
            WoW: <strong>{wow >= 0 ? `+${wow}%` : `${wow}%`}</strong> (prior 7d: {out7Prev})
          </div>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
          <div style={{ fontSize: 12, color: "#999" }}>Mix (last 7d)</div>
          <div style={{ fontSize: 22, fontWeight: 900, marginTop: 6 }}>
            Agents: {agents7} ({pct(agents7, out7)}) • Clients: {clients7} ({pct(clients7, out7)})
          </div>
          <div style={{ color: "#666", marginTop: 4 }}>Goal: keep agents meaningful while protecting clients.</div>
        </div>

        <div style={{ border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
          <div style={{ fontSize: 12, color: "#999" }}>Asks (last 30d)</div>
          <div style={{ fontSize: 22, fontWeight: 900, marginTop: 6 }}>
            Referrals: {refAsks30} • Reviews: {reviewAsks30}
          </div>
          <div style={{ color: "#666", marginTop: 4 }}>Tracked via touch intent.</div>
        </div>
      </div>

      {/* Active Coach */}
      <div style={{ marginTop: 18, border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Coach intervention</div>

        <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap", color: "#555" }}>
          <div style={{ border: "1px solid #ddd", borderRadius: 999, padding: "6px 10px" }}>
            Week-to-date outbound: <strong>{wtdOutbound}</strong> / {expectedOutboundWTD} (5/weekday)
          </div>
          <div style={{ border: "1px solid #ddd", borderRadius: 999, padding: "6px 10px" }}>
            Week-to-date agents: <strong>{wtdAgents}</strong> / {expectedAgentsWTD} (2/weekday)
          </div>
          <div style={{ border: "1px solid #ddd", borderRadius: 999, padding: "6px 10px" }}>
            Referral asks this week: <strong>{wtdReferralAsks}</strong> / 1
          </div>
          <div style={{ color: "#999", fontSize: 12, alignSelf: "center" }}>
            Weekday-only • Weekly aggregate scoring • Top 2 interventions
          </div>
        </div>

        <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
          {interventions.map((iv) => (
            <div key={iv.key} style={{ border: "1px solid #ddd", borderRadius: 14, padding: 12, background: "#fff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 900, fontSize: 16 }}>{iv.title}</div>
                  <div style={{ marginTop: 6, color: "#555" }}>{iv.summary}</div>
                  <div style={{ marginTop: 8, fontWeight: 800 }}>{iv.target}</div>
                </div>
                <div style={{ color: "#999", fontSize: 12, minWidth: 90, textAlign: "right" }}>
                  priority
                  <div style={{ fontWeight: 900, fontSize: 18, color: "#111" }}>{iv.priority}</div>
                </div>
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>Suggested contacts</div>
                {iv.suggested.length === 0 ? (
                  <div style={{ color: "#666" }}>No suggestions available yet (add more contacts / touches).</div>
                ) : (
                  <div style={{ display: "grid", gap: 8 }}>
                    {iv.suggested.map((s) => (
                      <div
                        key={s.contact_id}
                        style={{ border: "1px solid #eee", borderRadius: 12, padding: 10, display: "flex", justifyContent: "space-between", gap: 10 }}
                      >
                        <div>
                          <div style={{ fontWeight: 900 }}>
                            {s.display_name}{" "}
                            <span style={{ fontWeight: 600, color: "#666" }}>
                              • {categoryPretty(s.category)} {s.tier ? `• Tier ${s.tier}` : ""}
                            </span>
                          </div>
                          <div style={{ color: "#777", marginTop: 4 }}>
                            {s.why}
                            {typeof s.days_since_outbound === "number" ? ` • ${s.days_since_outbound}d` : ""}
                          </div>
                        </div>
                        <a
                          href="/morning"
                          style={{
                            alignSelf: "center",
                            padding: "8px 10px",
                            borderRadius: 10,
                            border: "1px solid #ddd",
                            textDecoration: "none",
                            color: "#111",
                            whiteSpace: "nowrap",
                          }}
                        >
                          Go act →
                        </a>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Database health */}
      <div style={{ marginTop: 18, border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Database health</div>
        <div style={{ marginTop: 8, color: "#666" }}>
          Contacts: <strong>{contactsTotal}</strong> • Clients: <strong>{clientsTotal}</strong> • Agents:{" "}
          <strong>{agentsTotal}</strong>
        </div>

        <div style={{ marginTop: 10, color: "#444" }}>
          A-Clients: <strong>{aClientsTotal}</strong> • A-Clients due/overdue (outbound):{" "}
          <strong>{aClientsDueOrOverdue}</strong>{" "}
          {!loadedHealth ? <span style={{ color: "#999" }}> (loading…)</span> : null}
          {aClientsVeryOverdue > 0 ? (
            <span style={{ marginLeft: 10, color: "crimson", fontWeight: 900 }}>
              • {aClientsVeryOverdue} very overdue
            </span>
          ) : null}
        </div>
      </div>

      {/* Warnings */}
      <div style={{ marginTop: 18, border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Early warnings</div>
        {warnings.length === 0 ? (
          <div style={{ marginTop: 8, color: "#666" }}>No warnings right now ✅</div>
        ) : (
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {warnings.map((w, i) => (
              <div key={i} style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12, background: "#fff" }}>
                <div style={{ fontWeight: 900 }}>{w.title}</div>
                <div style={{ marginTop: 6, color: "#555" }}>{w.detail}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Next actions */}
      <div style={{ marginTop: 18, border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Next actions</div>
        <ul style={{ marginTop: 10, paddingLeft: 18, color: "#444" }}>
          <li>
            Use <a href="/morning">Morning</a> to execute your Top 5.
          </li>
          <li>
            Tag at least 1 touch per week as <code>referral_ask</code>.
          </li>
          <li>
            If “Agent leverage drifting” appears, prioritize agents before the weekend.
          </li>
        </ul>
      </div>
    </div>
  );
}