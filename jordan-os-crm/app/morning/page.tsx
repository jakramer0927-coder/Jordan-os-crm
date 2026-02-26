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
  category: string; // Client, Agent, Developer, Vendor, Other
  tier: string | null; // A/B/C
  created_at: string;
};

type Touch = {
  id: string;
  contact_id: string;
  channel: "email" | "text" | "call" | "in_person" | "social_dm" | "other";
  direction: "outbound" | "inbound";
  occurred_at: string;
  summary: string | null;
  source: string | null;
  source_link: string | null;
  intent: TouchIntent | null;
};

type Row = Contact & {
  last_outbound_at: string | null;
  days_since_outbound: number | null;
  cadence_days: number;
  due_in_days: number | null;
  is_due: boolean;
  priority_score: number;
  why: string[];
  draft1: string;
  draft2: string;
};

function startOfTodayLocalISO() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - then) / (1000 * 60 * 60 * 24)));
}

function categoryPretty(category: string) {
  const c = (category || "").trim();
  if (!c) return "Other";
  return c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
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

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function computeScore(input: {
  category: string;
  tier: string | null;
  daysSinceOutbound: number | null;
  cadence: number;
}): { score: number; why: string[] } {
  const category = (input.category || "").toLowerCase();
  const tier = (input.tier || "").toUpperCase();
  const days = input.daysSinceOutbound;
  const cadence = input.cadence;

  const effectiveDays = days === null ? cadence + 1 : days;
  const overdueBy = effectiveDays - cadence;

  const overduePoints = clamp(Math.round((overdueBy / cadence) * 60), 0, 80);

  let tierPoints = 10;
  if (tier === "A") tierPoints = 35;
  else if (tier === "B") tierPoints = 20;

  let catPoints = 10;
  if (category === "client") catPoints = 30;
  else if (category === "agent") catPoints = 24;
  else if (category === "developer") catPoints = 18;

  let bonus = 0;
  if (category === "client" && tier === "A" && overdueBy >= 0) bonus += 25;
  if (category === "agent" && tier === "A" && overdueBy >= 0) bonus += 15;

  const score = tierPoints + catPoints + overduePoints + bonus;

  const why: string[] = [];
  why.push(`${categoryPretty(input.category)} • Tier ${tier || "—"}`);
  if (days === null) why.push(`No outbound touch logged yet (cadence ${cadence}d)`);
  else why.push(`${days} days since last outbound (cadence ${cadence}d)`);
  if (overdueBy >= 0) why.push(`Due/overdue by ${overdueBy} day${overdueBy === 1 ? "" : "s"}`);
  else why.push(`Not due yet (due in ${Math.abs(overdueBy)} days)`);

  if (bonus > 0) {
    if (category === "client" && tier === "A") why.push("Pinned behavior: A-Client due/overdue");
    else if (category === "agent" && tier === "A") why.push("Boost: Agent-A due/overdue");
  }

  return { score, why };
}

function makeDrafts(name: string, categoryRaw: string, tierRaw: string | null) {
  const category = (categoryRaw || "").toLowerCase();
  const tier = (tierRaw || "").toUpperCase();

  if (category === "client") {
    return {
      d1: `Hey ${name} — quick check-in. How’s everything going on your end this week?`,
      d2:
        tier === "A"
          ? `Hi ${name} — I’m mapping out the week and wanted to make sure you’re feeling supported. Anything you want me to prioritize right now?`
          : `Hi ${name} — quick touch base. Anything new on your timeline or preferences I should know about?`,
    };
  }

  if (category === "agent") {
    return {
      d1: `Hey ${name} — hope you’re doing well. Anything you’re working on right now where I can be helpful?`,
      d2:
        tier === "A"
          ? `Hi ${name} — quick one: I’m staying proactive with my network this week. Any buyers/sellers you want to team up on or keep an eye out for?`
          : `Hi ${name} — checking in. If anything comes across your desk where you want a second set of eyes, I’m around.`,
    };
  }

  if (category === "developer") {
    return {
      d1: `Hi ${name} — quick check-in. Any updates on current inventory or upcoming releases I should be aware of?`,
      d2: `Hey ${name} — I’m reviewing my active buyer pool. If you have anything new (or price movements), I’d love to align.`,
    };
  }

  return {
    d1: `Hey ${name} — quick check-in. Hope you’re having a good week.`,
    d2: `Hi ${name} — wanted to say hello and see if there’s anything you need from me.`,
  };
}

export default function MorningPage() {
  const [ready, setReady] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Today metrics
  const [touchesToday, setTouchesToday] = useState(0);
  const [agentTouchesToday, setAgentTouchesToday] = useState(0);

  // Log touch UI
  const [loggingFor, setLoggingFor] = useState<Row | null>(null);
  const [logChannel, setLogChannel] = useState<Touch["channel"]>("text");
  const [logIntent, setLogIntent] = useState<TouchIntent>("check_in");
  const [logSummary, setLogSummary] = useState("");
  const [logSource, setLogSource] = useState("manual");
  const [logLink, setLogLink] = useState("");
  const [saving, setSaving] = useState(false);

  const needs5 = Math.max(0, 5 - touchesToday);
  const needs2Agents = Math.max(0, 2 - agentTouchesToday);

  const top5 = useMemo(() => {
    const dueAClients = rows
      .filter((r) => r.category.toLowerCase() === "client" && (r.tier || "").toUpperCase() === "A" && r.is_due)
      .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));

    const agentCandidates = rows
      .filter((r) => r.category.toLowerCase() === "agent")
      .sort((a, b) => {
        if (a.is_due && !b.is_due) return -1;
        if (!a.is_due && b.is_due) return 1;
        return (b.priority_score ?? 0) - (a.priority_score ?? 0);
      });

    const others = rows
      .filter((r) => r.category.toLowerCase() !== "agent")
      .filter((r) => !(r.category.toLowerCase() === "client" && (r.tier || "").toUpperCase() === "A" && r.is_due))
      .sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));

    const combined: Row[] = [];
    const seen = new Set<string>();

    const push = (r: Row) => {
      if (combined.length >= 5) return;
      if (seen.has(r.id)) return;
      combined.push(r);
      seen.add(r.id);
    };

    for (const r of dueAClients) push(r);

    if (needs2Agents > 0) {
      for (const r of agentCandidates) {
        if (combined.length >= 5) break;
        push(r);
        const agentCountInList = combined.filter((x) => x.category.toLowerCase() === "agent").length;
        if (agentCountInList >= needs2Agents) break;
      }
    }

    for (const r of others) push(r);

    return combined;
  }, [rows, needs2Agents]);

  const dueCounts = useMemo(() => {
    const due = rows.filter((r) => r.is_due).length;
    const dueClientsA = rows.filter(
      (r) => r.is_due && r.category.toLowerCase() === "client" && (r.tier || "").toUpperCase() === "A"
    ).length;
    const dueAgents = rows.filter((r) => r.is_due && r.category.toLowerCase() === "agent").length;
    return { due, dueClientsA, dueAgents };
  }, [rows]);

  async function fetchContactsAndLastOutbound() {
    setError(null);

    const { data: cData, error: cErr } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, created_at")
      .order("created_at", { ascending: false })
      .limit(3000);

    if (cErr) {
      setError(`Contacts fetch error: ${cErr.message}`);
      setRows([]);
      return;
    }

    const contacts = (cData ?? []) as Contact[];
    if (contacts.length === 0) {
      setRows([]);
      return;
    }

    const ids = contacts.map((c) => c.id);

    const { data: tData, error: tErr } = await supabase
      .from("touches")
      .select("id, contact_id, channel, direction, occurred_at, summary, source, source_link, intent")
      .in("contact_id", ids)
      .eq("direction", "outbound")
      .order("occurred_at", { ascending: false })
      .limit(6000);

    if (tErr) setError((prev) => prev ?? `Touches fetch error: ${tErr.message}`);

    const touches = ((tData ?? []) as Touch[]) || [];
    const latestOutboundByContact = new Map<string, Touch>();
    for (const t of touches) {
      if (!latestOutboundByContact.has(t.contact_id)) latestOutboundByContact.set(t.contact_id, t);
    }

    const computed: Row[] = contacts.map((c) => {
      const last = latestOutboundByContact.get(c.id) ?? null;
      const lastAt = last ? last.occurred_at : null;
      const days = lastAt ? daysSince(lastAt) : null;

      const cadence = cadenceDays(c.category, c.tier);
      const isDue = days === null ? true : days >= cadence;
      const dueIn = days === null ? 0 : cadence - days;

      const { score, why } = computeScore({
        category: c.category,
        tier: c.tier,
        daysSinceOutbound: days,
        cadence,
      });

      const drafts = makeDrafts(c.display_name, c.category, c.tier);

      return {
        ...c,
        last_outbound_at: lastAt,
        days_since_outbound: days,
        cadence_days: cadence,
        due_in_days: dueIn,
        is_due: isDue,
        priority_score: score,
        why,
        draft1: drafts.d1,
        draft2: drafts.d2,
      };
    });

    computed.sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));
    setRows(computed);
  }

  async function fetchTodayMetrics() {
    setError(null);

    const since = startOfTodayLocalISO();

    const { data: tData, error: tErr } = await supabase
      .from("touches")
      .select("id, contact_id, direction, occurred_at")
      .eq("direction", "outbound")
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(5000);

    if (tErr) {
      setError(`Today metrics error: ${tErr.message}`);
      setTouchesToday(0);
      setAgentTouchesToday(0);
      return;
    }

    const touches = (tData ?? []) as Array<Pick<Touch, "id" | "contact_id" | "direction" | "occurred_at">>;
    setTouchesToday(touches.length);

    const ids = Array.from(new Set(touches.map((t) => t.contact_id)));
    if (ids.length === 0) {
      setAgentTouchesToday(0);
      return;
    }

    const { data: cData, error: cErr } = await supabase.from("contacts").select("id, category").in("id", ids);

    if (cErr) {
      setError((prev) => prev ?? `Today metrics (agent) error: ${cErr.message}`);
      setAgentTouchesToday(0);
      return;
    }

    const catById = new Map<string, string>();
    (cData ?? []).forEach((c: any) => catById.set(c.id, c.category));

    let agentCount = 0;
    for (const t of touches) {
      if ((catById.get(t.contact_id) || "").toLowerCase() === "agent") agentCount += 1;
    }
    setAgentTouchesToday(agentCount);
  }

  async function refreshAll() {
    await Promise.all([fetchContactsAndLastOutbound(), fetchTodayMetrics()]);
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  function openLog(r: Row) {
    setLoggingFor(r);
    setLogChannel(r.category.toLowerCase() === "agent" ? "text" : "text");
    setLogIntent("check_in");
    setLogSummary("");
    setLogSource("manual");
    setLogLink("");
  }

  async function saveLog() {
    if (!loggingFor) return;

    setSaving(true);
    setError(null);

    const occurredAt = new Date().toISOString();

    const { error } = await supabase.from("touches").insert({
      contact_id: loggingFor.id,
      channel: logChannel,
      direction: "outbound",
      intent: logIntent,
      occurred_at: occurredAt,
      summary: logSummary.trim() ? logSummary.trim() : null,
      source: logSource.trim() ? logSource.trim() : null,
      source_link: logLink.trim() ? logLink.trim() : null,
    });

    setSaving(false);

    if (error) {
      setError(`Insert touch error: ${error.message}`);
      return;
    }

    setLoggingFor(null);
    await refreshAll();
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

      setUserId(uid);
      setReady(true);
      await refreshAll();
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const uid = session?.user.id ?? null;
      setUserId(uid);
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
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0 }}>Morning Run</h1>
          <div style={{ marginTop: 6, color: "#666" }}>
            Due total: <strong>{dueCounts.due}</strong> • Due A-Clients: <strong>{dueCounts.dueClientsA}</strong> • Due Agents:{" "}
            <strong>{dueCounts.dueAgents}</strong>
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ border: "1px solid #ddd", borderRadius: 999, padding: "6px 10px" }}>
              Outbound touches today: <strong>{touchesToday}</strong> / 5 {needs5 > 0 ? `• need ${needs5}` : "• ✅"}
            </div>
            <div style={{ border: "1px solid #ddd", borderRadius: 999, padding: "6px 10px" }}>
              Agent touches today: <strong>{agentTouchesToday}</strong> / 2 {needs2Agents > 0 ? `• need ${needs2Agents}` : "• ✅"}
            </div>
            <div style={{ color: "#999", fontSize: 12 }}>
              Outbound-only cadence • user {userId ? userId.slice(0, 8) + "…" : ""}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
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
          <button
            onClick={signOut}
            style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
          >
            Sign out
          </button>
        </div>
      </div>

      {error && <div style={{ marginTop: 14, color: "crimson", fontWeight: 800 }}>{error}</div>}

      <div style={{ marginTop: 18 }}>
        {top5.map((r, idx) => (
          <div
            key={r.id}
            style={{
              border: "1px solid #e5e5e5",
              borderRadius: 14,
              padding: 14,
              marginBottom: 12,
              background: r.is_due ? "#fff" : "#fafafa",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 16 }}>
                  {idx + 1}. {r.display_name}
                  {r.is_due ? (
                    <span
                      style={{
                        marginLeft: 10,
                        fontSize: 12,
                        padding: "2px 8px",
                        border: "1px solid #ddd",
                        borderRadius: 999,
                      }}
                    >
                      DUE
                    </span>
                  ) : null}
                  {r.category.toLowerCase() === "agent" && needs2Agents > 0 ? (
                    <span
                      style={{
                        marginLeft: 8,
                        fontSize: 12,
                        padding: "2px 8px",
                        border: "1px solid #ddd",
                        borderRadius: 999,
                      }}
                    >
                      agent quota
                    </span>
                  ) : null}
                </div>

                <div style={{ color: "#555", marginTop: 4 }}>
                  {categoryPretty(r.category)} {r.tier ? `• Tier ${r.tier}` : ""}
                </div>

                <div style={{ color: "#777", marginTop: 6, fontSize: 13 }}>
                  Last outbound: <strong>{r.last_outbound_at ? new Date(r.last_outbound_at).toLocaleString() : "—"}</strong>
                  {typeof r.days_since_outbound === "number" ? ` • ${r.days_since_outbound}d ago` : ""}
                  {` • cadence ${r.cadence_days}d`}
                </div>

                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>Why this is in your Top 5</div>
                  <ul style={{ margin: 0, paddingLeft: 18, color: "#444" }}>
                    {r.why.map((w, i) => (
                      <li key={i} style={{ marginBottom: 4 }}>
                        {w}
                      </li>
                    ))}
                    <li style={{ marginBottom: 4 }}>
                      Priority score: <strong>{r.priority_score}</strong>
                    </li>
                  </ul>
                </div>

                <div style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>Drafts</div>
                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 10, background: "#fff" }}>
                      <div style={{ fontSize: 12, color: "#999", marginBottom: 4 }}>Draft 1</div>
                      <div>{r.draft1}</div>
                    </div>
                    <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 10, background: "#fff" }}>
                      <div style={{ fontSize: 12, color: "#999", marginBottom: 4 }}>Draft 2</div>
                      <div>{r.draft2}</div>
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ minWidth: 160, display: "flex", flexDirection: "column", gap: 10 }}>
                <button
                  onClick={() => openLog(r)}
                  style={{
                    padding: "10px 14px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    cursor: "pointer",
                    fontWeight: 800,
                  }}
                >
                  Log touch
                </button>

                <button
                  onClick={() => navigator.clipboard.writeText(r.draft1)}
                  style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
                >
                  Copy draft 1
                </button>

                <button
                  onClick={() => navigator.clipboard.writeText(r.draft2)}
                  style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
                >
                  Copy draft 2
                </button>

                <div style={{ color: "#999", fontSize: 12 }}>Log after you send.</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {loggingFor && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            padding: 16,
          }}
        >
          <div style={{ width: "min(760px, 100%)", background: "#fff", borderRadius: 16, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Log outbound touch</div>
                <div style={{ color: "#666", marginTop: 4 }}>
                  {loggingFor.display_name} • {categoryPretty(loggingFor.category)}
                  {loggingFor.tier ? ` • Tier ${loggingFor.tier}` : ""}
                </div>
              </div>
              <button
                onClick={() => setLoggingFor(null)}
                style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
              >
                Close
              </button>
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ fontSize: 12, color: "#666" }}>
                Channel
                <select
                  value={logChannel}
                  onChange={(e) => setLogChannel(e.target.value as any)}
                  style={{ display: "block", padding: 10, marginTop: 6 }}
                >
                  <option value="email">email</option>
                  <option value="text">text</option>
                  <option value="call">call</option>
                  <option value="in_person">in_person</option>
                  <option value="social_dm">social_dm</option>
                  <option value="other">other</option>
                </select>
              </label>

              <label style={{ fontSize: 12, color: "#666" }}>
                Intent
                <select
                  value={logIntent}
                  onChange={(e) => setLogIntent(e.target.value as any)}
                  style={{ display: "block", padding: 10, marginTop: 6 }}
                >
                  <option value="check_in">check_in</option>
                  <option value="referral_ask">referral_ask</option>
                  <option value="review_ask">review_ask</option>
                  <option value="deal_followup">deal_followup</option>
                  <option value="collaboration">collaboration</option>
                  <option value="event_invite">event_invite</option>
                  <option value="other">other</option>
                </select>
              </label>

              <label style={{ fontSize: 12, color: "#666" }}>
                Source
                <input
                  value={logSource}
                  onChange={(e) => setLogSource(e.target.value)}
                  placeholder="manual / gmail / sms"
                  style={{
                    display: "block",
                    padding: 10,
                    marginTop: 6,
                    width: 240,
                    borderRadius: 10,
                    border: "1px solid #ddd",
                  }}
                />
              </label>

              <label style={{ fontSize: 12, color: "#666", flex: 1, minWidth: 260 }}>
                Link (optional)
                <input
                  value={logLink}
                  onChange={(e) => setLogLink(e.target.value)}
                  placeholder="paste Gmail thread link, etc."
                  style={{
                    display: "block",
                    padding: 10,
                    marginTop: 6,
                    width: "100%",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                  }}
                />
              </label>
            </div>

            <div style={{ marginTop: 10 }}>
              <label style={{ fontSize: 12, color: "#666" }}>
                Summary (optional)
                <textarea
                  value={logSummary}
                  onChange={(e) => setLogSummary(e.target.value)}
                  placeholder="Quick note about what you sent / what you discussed"
                  style={{
                    display: "block",
                    width: "100%",
                    minHeight: 90,
                    padding: 10,
                    marginTop: 6,
                    borderRadius: 10,
                    border: "1px solid #ddd",
                  }}
                />
              </label>
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              <button
                onClick={saveLog}
                disabled={saving}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  cursor: "pointer",
                  fontWeight: 900,
                }}
              >
                {saving ? "Saving…" : "Save touch"}
              </button>
              <button
                onClick={() => setLoggingFor(null)}
                style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
              >
                Cancel
              </button>
            </div>

            <div style={{ marginTop: 10, color: "#999", fontSize: 12 }}>
              Outbound touches reset cadence. Inbound replies do not.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}