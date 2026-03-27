"use client";

import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

type Contact = {
  id: string;
  display_name: string;
  category: string;
  tier: string | null;
};

type Touch = {
  id: string;
  contact_id: string;
  direction: "outbound" | "inbound";
  occurred_at: string;
  intent: string | null;
};

function daysSince(iso: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

function cadenceDays(cat: string, tier: string | null): number {
  const c = (cat || "").toLowerCase();
  const t = (tier || "").toUpperCase();
  if (c === "client") return t === "A" ? 30 : t === "B" ? 60 : 90;
  if (c === "sphere") return t === "A" ? 60 : t === "B" ? 90 : 120;
  if (c === "agent") return t === "A" ? 30 : 60;
  if (c === "developer") return 60;
  return 90;
}

function startOfWeekMonday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - ((day + 6) % 7));
  return d;
}

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ height: 6, background: "rgba(0,0,0,0.07)", borderRadius: 4, overflow: "hidden", marginTop: 6 }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4, transition: "width 0.3s" }} />
    </div>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="card cardPad">
      <div style={{ fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ fontSize: 32, fontWeight: 900, lineHeight: 1.1, marginTop: 6, color: color || "inherit" }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#888", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export default function InsightsPage() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [lastOutboundById, setLastOutboundById] = useState<Map<string, string>>(new Map());
  const [touches7, setTouches7] = useState<Touch[]>([]);
  const [touches30, setTouches30] = useState<Touch[]>([]);
  const [touchesWTD, setTouchesWTD] = useState<Touch[]>([]);

  // --- derived ---

  const categoryMap = useMemo(() => {
    const m = new Map<string, string>();
    contacts.forEach((c) => m.set(c.id, (c.category || "").toLowerCase()));
    return m;
  }, [contacts]);

  const tierMap = useMemo(() => {
    const m = new Map<string, string | null>();
    contacts.forEach((c) => m.set(c.id, c.tier));
    return m;
  }, [contacts]);

  // WTD breakdown
  const wtdTotal = touchesWTD.length;
  const weekdaysElapsed = (() => {
    const day = new Date().getDay();
    if (day === 0 || day === 6) return 5;
    return day;
  })();
  const wtdGoal = weekdaysElapsed * 5;
  const wtdAgents = touchesWTD.filter((t) => categoryMap.get(t.contact_id) === "agent").length;
  const wtdAgentGoal = weekdaysElapsed * 2;
  const wtdReferralAsks = touchesWTD.filter((t) => t.intent === "referral_ask").length;

  // 30-day breakdown by category
  const breakdown30 = useMemo(() => {
    const counts: Record<string, number> = {};
    const people: Record<string, Set<string>> = {};
    for (const t of touches30) {
      const cat = categoryMap.get(t.contact_id) || "other";
      counts[cat] = (counts[cat] || 0) + 1;
      if (!people[cat]) people[cat] = new Set();
      people[cat].add(t.contact_id);
    }
    return { counts, people };
  }, [touches30, categoryMap]);

  // Cadence compliance
  const compliance = useMemo(() => {
    const results: {
      contact: Contact;
      daysSince: number | null;
      cadence: number;
      overdue: boolean;
      overdueBy: number;
    }[] = [];

    for (const c of contacts) {
      const last = lastOutboundById.get(c.id) ?? null;
      const d = last ? daysSince(last) : null;
      const cad = cadenceDays(c.category, c.tier);
      const overdue = d === null || d >= cad;
      const overdueBy = d === null ? cad + 999 : d - cad;
      results.push({ contact: c, daysSince: d, cadence: cad, overdue, overdueBy });
    }

    return results;
  }, [contacts, lastOutboundById]);

  const overdueAll = compliance.filter((x) => x.overdue);
  const onTrackAll = compliance.filter((x) => !x.overdue);

  const overdueByCategory = useMemo(() => {
    const out: Record<string, { overdue: number; total: number }> = {};
    for (const x of compliance) {
      const cat = (x.contact.category || "other").toLowerCase();
      if (!out[cat]) out[cat] = { overdue: 0, total: 0 };
      out[cat].total += 1;
      if (x.overdue) out[cat].overdue += 1;
    }
    return out;
  }, [compliance]);

  const mostOverdue = useMemo(() => {
    return overdueAll
      .sort((a, b) => b.overdueBy - a.overdueBy)
      .slice(0, 8);
  }, [overdueAll]);

  // --- fetch ---
  async function fetchAll() {
    setError(null);

    const now = new Date();
    const since7 = new Date(now); since7.setDate(since7.getDate() - 7); since7.setHours(0, 0, 0, 0);
    const since30 = new Date(now); since30.setDate(since30.getDate() - 30); since30.setHours(0, 0, 0, 0);
    const monday = startOfWeekMonday();

    const [cRes, loRes, t30Res, tWTDRes] = await Promise.all([
      supabase.from("contacts").select("id, display_name, category, tier").eq("archived", false).limit(5000),
      supabase.from("contact_last_outbound").select("contact_id, last_outbound_at").limit(5000),
      supabase.from("touches").select("id, contact_id, direction, occurred_at, intent").eq("direction", "outbound").gte("occurred_at", since30.toISOString()).limit(10000),
      supabase.from("touches").select("id, contact_id, direction, occurred_at, intent").eq("direction", "outbound").gte("occurred_at", monday.toISOString()).limit(5000),
    ]);

    if (cRes.error) { setError(cRes.error.message); return; }
    if (loRes.error) { setError(loRes.error.message); return; }

    const cs = (cRes.data ?? []) as Contact[];
    setContacts(cs);

    const loMap = new Map<string, string>();
    (loRes.data ?? []).forEach((r: any) => { if (r.last_outbound_at) loMap.set(r.contact_id, r.last_outbound_at); });
    setLastOutboundById(loMap);

    const t30 = (t30Res.data ?? []) as Touch[];
    setTouches30(t30);
    setTouches7(t30.filter((t) => t.occurred_at >= since7.toISOString()));
    setTouchesWTD((tWTDRes.data ?? []) as Touch[]);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { window.location.href = "/login"; return; }
      setReady(true);
      fetchAll();
    });
  }, []);

  if (!ready) return <div className="page">Loading…</div>;

  const CATEGORIES = ["client", "sphere", "agent", "developer", "vendor", "other"];

  return (
    <div className="page">
      <div className="pageHeader">
        <div>
          <h1 className="h1">Insights</h1>
          <div className="muted" style={{ marginTop: 6 }}>{contacts.length} contacts tracked</div>
        </div>
        <div className="row">
          <a className="btn" href="/morning">Morning</a>
          <a className="btn" href="/contacts">Contacts</a>
          <button className="btn" onClick={fetchAll}>Refresh</button>
        </div>
      </div>

      {error && <div className="alert alertError">{error}</div>}

      {/* === THIS WEEK === */}
      <div style={{ fontWeight: 900, fontSize: 13, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
        This week
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 16 }}>
        <StatCard
          label="Outreach"
          value={wtdTotal}
          sub={`Goal: ${wtdGoal} (5/weekday)`}
          color={wtdTotal >= wtdGoal ? "#15803d" : wtdTotal >= wtdGoal * 0.7 ? "#b45309" : "#b91c1c"}
        />
        <StatCard
          label="Agent touches"
          value={wtdAgents}
          sub={`Goal: ${wtdAgentGoal} (2/weekday)`}
          color={wtdAgents >= wtdAgentGoal ? "#15803d" : "#b91c1c"}
        />
        <StatCard
          label="Referral asks"
          value={wtdReferralAsks}
          sub="Goal: 1/week"
          color={wtdReferralAsks >= 1 ? "#15803d" : "#b91c1c"}
        />
        <StatCard
          label="Last 7 days"
          value={touches7.length}
          sub={`Last 30 days: ${touches30.length}`}
        />
      </div>

      {/* Progress bars */}
      <div className="card cardPad" style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ fontWeight: 700 }}>Outreach pace</span>
              <span style={{ color: "#888" }}>{wtdTotal} / {wtdGoal}</span>
            </div>
            <ProgressBar value={wtdTotal} max={wtdGoal} color={wtdTotal >= wtdGoal ? "#15803d" : "#f59e0b"} />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ fontWeight: 700 }}>Agent coverage</span>
              <span style={{ color: "#888" }}>{wtdAgents} / {wtdAgentGoal}</span>
            </div>
            <ProgressBar value={wtdAgents} max={wtdAgentGoal} color={wtdAgents >= wtdAgentGoal ? "#15803d" : "#b91c1c"} />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ fontWeight: 700 }}>Referral asks</span>
              <span style={{ color: "#888" }}>{wtdReferralAsks} / 1</span>
            </div>
            <ProgressBar value={wtdReferralAsks} max={1} color="#15803d" />
          </div>
        </div>
      </div>

      {/* === LAST 30 DAYS BREAKDOWN === */}
      <div style={{ fontWeight: 900, fontSize: 13, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
        Last 30 days — by relationship type
      </div>

      <div className="card cardPad" style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gap: 10 }}>
          {CATEGORIES.filter((cat) => overdueByCategory[cat] || breakdown30.counts[cat]).map((cat) => {
            const touched = breakdown30.counts[cat] || 0;
            const uniquePeople = breakdown30.people[cat]?.size || 0;
            const ov = overdueByCategory[cat] || { overdue: 0, total: 0 };
            const compliancePct = ov.total > 0 ? Math.round(((ov.total - ov.overdue) / ov.total) * 100) : 100;
            const label = cat.charAt(0).toUpperCase() + cat.slice(1);
            return (
              <div key={cat} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 80, fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{label}</div>
                <div style={{ flex: 1 }}>
                  <ProgressBar
                    value={ov.total - ov.overdue}
                    max={ov.total}
                    color={compliancePct >= 80 ? "#15803d" : compliancePct >= 50 ? "#f59e0b" : "#b91c1c"}
                  />
                </div>
                <div style={{ fontSize: 12, color: "#888", flexShrink: 0, minWidth: 160, textAlign: "right" }}>
                  {touched} touches · {uniquePeople} people · <strong style={{ color: compliancePct >= 80 ? "#15803d" : "#b91c1c" }}>{compliancePct}% on cadence</strong>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* === WHERE YOU STAND === */}
      <div style={{ fontWeight: 900, fontSize: 13, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
        Cadence compliance
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 16 }}>
        <StatCard
          label="On track"
          value={onTrackAll.length}
          sub={`${contacts.length > 0 ? Math.round((onTrackAll.length / contacts.length) * 100) : 0}% of contacts`}
          color="#15803d"
        />
        <StatCard
          label="Overdue"
          value={overdueAll.length}
          sub={`${contacts.length > 0 ? Math.round((overdueAll.length / contacts.length) * 100) : 0}% of contacts`}
          color={overdueAll.length > 0 ? "#b91c1c" : "#15803d"}
        />
        {overdueByCategory["client"] && (
          <StatCard
            label="Clients overdue"
            value={overdueByCategory["client"].overdue}
            sub={`of ${overdueByCategory["client"].total} total`}
            color={overdueByCategory["client"].overdue > 0 ? "#b91c1c" : "#15803d"}
          />
        )}
        {overdueByCategory["agent"] && (
          <StatCard
            label="Agents overdue"
            value={overdueByCategory["agent"].overdue}
            sub={`of ${overdueByCategory["agent"].total} total`}
            color={overdueByCategory["agent"].overdue > 5 ? "#b91c1c" : "#b45309"}
          />
        )}
      </div>

      {/* === MOST OVERDUE === */}
      {mostOverdue.length > 0 && (
        <>
          <div style={{ fontWeight: 900, fontSize: 13, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
            Most overdue
          </div>
          <div className="card cardPad" style={{ marginBottom: 16 }}>
            <div style={{ display: "grid", gap: 8 }}>
              {mostOverdue.map(({ contact, daysSince: d, cadence, overdueBy }) => (
                <div key={contact.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ fontSize: 20, fontWeight: 900, color: "#b91c1c", minWidth: 44, textAlign: "center", lineHeight: 1 }}>
                    {d ?? "∞"}
                    <div style={{ fontSize: 10, color: "#aaa", fontWeight: 600 }}>days</div>
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <a href={`/contacts/${contact.id}`} style={{ fontWeight: 700, fontSize: 14 }}>{contact.display_name}</a>
                    <div style={{ fontSize: 12, color: "#888" }}>
                      {contact.category}{contact.tier ? ` · ${contact.tier}` : ""} · cadence {cadence}d
                      {overdueBy > 0 && <span style={{ color: "#b91c1c", marginLeft: 6 }}>+{overdueBy}d overdue</span>}
                    </div>
                  </div>
                  <a className="btn" href={`/contacts/${contact.id}`} style={{ textDecoration: "none", fontSize: 12, flexShrink: 0 }}>
                    Open →
                  </a>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
