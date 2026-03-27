"use client";

import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

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
  category: string;
  tier: string | null;
  client_type: string | null;
  email: string | null;
  created_at: string;
};

type Touch = {
  id: string;
  contact_id: string;
  channel: "email" | "text" | "call" | "in_person" | "social_dm" | "other";
  direction: "outbound" | "inbound";
  occurred_at: string;
  intent: TouchIntent | null;
  summary: string | null;
  source: string | null;
  source_link: string | null;
};

type ContactWithLastOutbound = Contact & {
  last_outbound_at: string | null;
  last_outbound_channel: Touch["channel"] | null;
  last_outbound_summary: string | null;
  days_since_outbound: number | null;
};

type VoiceProfile = {
  ok: boolean;
  count: number;
  rules: string[];
  topPhrases?: Array<{ phrase: string; count: number }>;
  stats?: {
    avgLen: number;
    percentQuestions: number;
    percentEmDash: number;
    percentWarm: number;
    percentValue: number;
    percentSoftClose: number;
    percentExclaim: number;
  } | null;
  examples: Array<{
    id: string;
    channel: string;
    intent: string | null;
    contact_category: string | null;
    occurred_at: string | null;
    text: string;
    len: number;
  }>;
};

function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(0, days);
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}

function isWeekdayLocal(): boolean {
  const d = new Date().getDay();
  return d >= 1 && d <= 5;
}

function cadenceDays(category: string, tier: string | null): number {
  const cat = (category || "").toLowerCase();
  const t = (tier || "").toUpperCase();

  if (cat === "client") {
    if (t === "A") return 30;
    if (t === "B") return 60;
    if (t === "C") return 90;
    return 60;
  }
  if (cat === "agent") {
    if (t === "A") return 30;
    return 60;
  }
  if (cat === "developer") return 60;
  if (cat === "vendor") return 60;
  return 60;
}

function isOverdue(c: ContactWithLastOutbound): boolean {
  const cadence = cadenceDays(c.category, c.tier);
  if (c.days_since_outbound == null) return true;
  return c.days_since_outbound >= cadence;
}

function isAClient(c: ContactWithLastOutbound): boolean {
  return (c.category || "").toLowerCase() === "client" && (c.tier || "").toUpperCase() === "A";
}

function isAgentA(c: ContactWithLastOutbound): boolean {
  return (c.category || "").toLowerCase() === "agent" && (c.tier || "").toUpperCase() === "A";
}

function categoryBadge(c: ContactWithLastOutbound) {
  const cat = (c.category || "Other").trim();
  const tier = c.tier ? ` • Tier ${c.tier}` : "";
  const ct = c.client_type ? ` • ${c.client_type}` : "";
  return `${cat}${tier}${ct}`;
}

function pickChannel(c: ContactWithLastOutbound): Touch["channel"] {
  const cat = (c.category || "").toLowerCase();
  if (cat === "agent" || cat === "developer" || cat === "vendor") return "email";
  return "text";
}

function firstName(displayName: string): string {
  const first = (displayName || "").trim().split(/\s+/)[0] || "";
  return first || "there";
}

function choose<T>(arr: T[], fallback: T): T {
  if (!arr || arr.length === 0) return fallback;
  return arr[Math.floor(Math.random() * arr.length)] || fallback;
}

function buildDraftWithVoice(opts: {
  contact: ContactWithLastOutbound;
  intent: TouchIntent;
  channel: Touch["channel"];
  voice: VoiceProfile | null;
}): string {
  const c = opts.contact;
  const cat = (c.category || "").toLowerCase();
  const name = firstName(c.display_name);

  const openers = [
    `Hey ${name} — quick one.`,
    `Hey ${name} — quick check-in.`,
    `Hi ${name} — quick note.`,
    `Hey ${name} — hope you're doing well.`,
  ];

  const softCloses = [
    "No rush — just let me know.",
    "If helpful, happy to share more.",
    "Happy to be a sounding board.",
    "Keep me posted when you have a sec.",
  ];

  const agentValues = [
    "I've got an active buyer in the market right now and I'm keeping my eyes open.",
    "I'm seeing a little shift in buyer sensitivity — curious what you're noticing.",
    "I'm comparing a few pockets right now — always interested in anything quiet/off-market.",
  ];

  const agentAsks = [
    "Do you have anything coming up (or off-market) that I should know about?",
    "What are you seeing right now on pricing + demand?",
    "Any inventory you're watching that feels like it's about to trade?",
  ];

  const clientValues = [
    "Just checking in and making sure everything's going smoothly on your end.",
    "Wanted to say hi — it's been a minute and I figured I'd reach out.",
    "Quick pulse check — I've been watching the market closely and thought of you.",
  ];

  const clientAsks = [
    "Anything real-estate related on your mind right now?",
    "Any changes in your plans this spring?",
    "Want me to keep an eye out for anything specific, or run a quick value check?",
  ];

  const devValues = [
    "Checking in — curious what you're seeing on absorption + buyer feedback right now.",
    "Wanted to reconnect and see what's in the pipeline.",
    "Quick note — I'm tracking a few new-build comps and would love to compare notes.",
  ];

  const devAsks = [
    "Anything upcoming that fits the current moment?",
    "What's your read on pricing strategy this quarter?",
    "Are you seeing more pushback on finishes or layout lately?",
  ];

  const vendorValues = [
    "Quick check-in — hope business is good on your side.",
    "Wanted to stay in touch — I've got a few projects moving and may need help soon.",
    "Quick note — I'm tightening up my vendor bench and making sure I've got the right partners queued.",
  ];

  const vendorAsks = [
    "What's your schedule look like over the next couple weeks?",
    "Any changes to pricing or lead times I should be aware of?",
    "If I loop you in on something, what's the fastest way to get it on your radar?",
  ];

  const voice = opts.voice;
  let opener = choose(openers, `Hey ${name} — quick one.`);
  let close = choose(softCloses, "No rush — just let me know.");

  if (voice?.topPhrases?.some((p) => p.phrase === "no rush")) close = "No rush — just let me know.";
  if (voice?.topPhrases?.some((p) => p.phrase === "quick one")) opener = `Hey ${name} — quick one.`;

  let value = "";
  let ask = "";

  if (cat === "agent") {
    value = choose(agentValues, agentValues[0]);
    ask = choose(agentAsks, agentAsks[0]);
  } else if (cat === "developer") {
    value = choose(devValues, devValues[0]);
    ask = choose(devAsks, devAsks[0]);
  } else if (cat === "vendor") {
    value = choose(vendorValues, vendorValues[0]);
    ask = choose(vendorAsks, vendorAsks[0]);
  } else {
    value = choose(clientValues, clientValues[0]);
    ask = choose(clientAsks, clientAsks[0]);
  }

  if (opts.intent === "referral_ask") {
    ask =
      cat === "agent"
        ? "If you bump into anyone who needs a strong agent on the buy side, I'd really appreciate a quick intro."
        : "If anyone comes up in your world who needs help buying or selling, I'd be grateful for an intro.";
  }

  if (opts.intent === "review_ask") {
    ask =
      "Also — if you have 30 seconds, would you be open to leaving a quick review? It helps more than you'd think.";
  }

  const isText = opts.channel === "text";
  const body = isText
    ? `${opener} ${value} ${ask} ${close}`
    : `${opener}\n\n${value}\n${ask}\n\n${close}`;

  return body.trim();
}

type Recommendation = ContactWithLastOutbound & {
  cadence: number;
  overdue: boolean;
  score: number;
  reasons: string[];
  suggested_channel: Touch["channel"];
  suggested_draft: string;
};

export default function MorningPage() {
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);

  const [contacts, setContacts] = useState<ContactWithLastOutbound[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // voice
  const [voice, setVoice] = useState<VoiceProfile | null>(null);
  const [voiceLoaded, setVoiceLoaded] = useState(false);

  // logging touch inline
  const [loggingFor, setLoggingFor] = useState<string | null>(null);
  const [touchChannel, setTouchChannel] = useState<Touch["channel"]>("text");
  const [touchSummary, setTouchSummary] = useState("");
  const [savingTouch, setSavingTouch] = useState(false);
  // quick log (no note) — shows "add note" option after
  const [quickLoggedFor, setQuickLoggedFor] = useState<string | null>(null);

  // stable list + completed tracking
  const [lockedIds, setLockedIds] = useState<string[] | null>(null);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());

  async function requireSession() {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user ?? null;
    if (!user) {
      window.location.href = "/login";
      return null;
    }
    setUid(user.id);
    return user;
  }

  async function loadVoiceProfile(userId: string) {
    try {
      const res = await fetch(`/api/voice/profile?uid=${userId}&limit=120&minLen=140`);
      const j = (await res.json()) as VoiceProfile | { error?: string };
      if (!res.ok) return;
      if ((j as VoiceProfile).ok) setVoice(j as VoiceProfile);
    } catch {
      // ignore
    } finally {
      setVoiceLoaded(true);
    }
  }

  async function load() {
    setError(null);
    setMsg(null);
    setLoading(true);

    const user = await requireSession();
    if (!user) { setLoading(false); return; }

    if (!voiceLoaded) await loadVoiceProfile(user.id);

    const { data: cData, error: cErr } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, client_type, email, created_at")
      .order("created_at", { ascending: false })
      .limit(2000);

    if (cErr) {
      setError(`Contacts fetch error: ${cErr.message}`);
      setContacts([]);
      setLoading(false);
      return;
    }

    const base = (cData ?? []) as Contact[];
    if (base.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    const { data: tData, error: tErr } = await supabase
      .from("touches")
      .select(
        "id, contact_id, channel, direction, occurred_at, intent, summary, source, source_link",
      )
      .eq("direction", "outbound")
      .order("occurred_at", { ascending: false })
      .limit(4000);

    if (tErr) {
      setError(`Touches fetch error: ${tErr.message}`);
      const mergedFail: ContactWithLastOutbound[] = base.map((c) => ({
        ...c,
        last_outbound_at: null,
        last_outbound_channel: null,
        last_outbound_summary: null,
        days_since_outbound: null,
      }));
      setContacts(mergedFail);
      setLoading(false);
      return;
    }

    const touches = (tData ?? []) as Touch[];
    const latestOutbound = new Map<string, Touch>();
    for (const t of touches) {
      if (!latestOutbound.has(t.contact_id)) latestOutbound.set(t.contact_id, t);
    }

    const merged: ContactWithLastOutbound[] = base.map((c) => {
      const last = latestOutbound.get(c.id) ?? null;
      return {
        ...c,
        last_outbound_at: last ? last.occurred_at : null,
        last_outbound_channel: last ? last.channel : null,
        last_outbound_summary: last ? last.summary : null,
        days_since_outbound: last ? daysSince(last.occurred_at) : null,
      };
    });

    setContacts(merged);
    setLoading(false);
  }

  function openLog(c: Recommendation) {
    setLoggingFor(c.id);
    setTouchChannel(c.suggested_channel);
    setTouchSummary("");
    setQuickLoggedFor(null);
  }

  async function quickLog(c: Recommendation) {
    setSavingTouch(true);
    setError(null);

    const { error: insErr } = await supabase.from("touches").insert({
      contact_id: c.id,
      channel: c.suggested_channel,
      direction: "outbound",
      intent: "check_in",
      occurred_at: new Date().toISOString(),
      summary: null,
      source: "manual",
    });

    setSavingTouch(false);

    if (insErr) {
      setError(`Insert touch error: ${insErr.message}`);
      return;
    }

    setCompletedIds((prev) => new Set([...prev, c.id]));
    setQuickLoggedFor(c.id);
  }

  async function saveTouch() {
    if (!loggingFor) return;
    setSavingTouch(true);
    setError(null);
    setMsg(null);

    const { error: insErr } = await supabase.from("touches").insert({
      contact_id: loggingFor,
      channel: touchChannel,
      direction: "outbound",
      intent: "check_in",
      occurred_at: new Date().toISOString(),
      summary: touchSummary.trim() ? touchSummary.trim() : null,
      source: "manual",
    });

    setSavingTouch(false);

    if (insErr) {
      setError(`Insert touch error: ${insErr.message}`);
      return;
    }

    setCompletedIds((prev) => new Set([...prev, loggingFor]));
    setMsg("Logged ✓");
    setLoggingFor(null);
    setQuickLoggedFor(null);
  }

  useEffect(() => {
    let alive = true;

    const init = async () => {
      const user = await requireSession();
      if (!alive) return;
      if (!user) return;

      setReady(true);
      await load();
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const u = session?.user ?? null;
      if (!u) window.location.href = "/login";
    });

    init();

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recs = useMemo<Recommendation[]>(() => {
    const weekday = isWeekdayLocal();

    const scored: Recommendation[] = contacts.map((c) => {
      const cadence = cadenceDays(c.category, c.tier);
      const overdue = isOverdue(c);
      const d = c.days_since_outbound;

      const reasons: string[] = [];
      if (overdue) reasons.push(`Overdue (cadence ${cadence}d)`);
      if (d == null) reasons.push("No outbound logged yet");
      else reasons.push(`${d} days since outbound`);

      if (isAClient(c)) reasons.push("A-Client (never miss)");
      if (isAgentA(c)) reasons.push("Agent-A priority");
      if ((c.category || "").toLowerCase() === "developer") reasons.push("Developer cadence 60d");

      let score = 0;
      if (isAClient(c)) score += 1000;
      if (overdue) score += 300;
      score += (d ?? cadence) * 2;

      const cat = (c.category || "").toLowerCase();
      if (cat === "agent") score += 60;
      if (cat === "developer") score += 40;
      if (cat === "client") score += 80;
      if (cat === "vendor") score += 30;

      const t = (c.tier || "").toUpperCase();
      if (t === "A") score += 40;
      if (t === "B") score += 20;

      if (!weekday) score -= 30;

      const suggested_channel = pickChannel(c);

      const suggested_draft = buildDraftWithVoice({
        contact: c,
        intent: "check_in",
        channel: suggested_channel,
        voice,
      });

      return { ...c, cadence, overdue, score, reasons, suggested_channel, suggested_draft };
    });

    scored.sort((a, b) => b.score - a.score);

    const top: Recommendation[] = [];
    const used = new Set<string>();

    const overdueAClients = scored.filter((c) => isAClient(c) && c.overdue);
    for (const c of overdueAClients) {
      if (top.length >= 5) break;
      top.push(c);
      used.add(c.id);
    }

    const agentsNeeded = 2;
    const agentPool = scored.filter(
      (c) => (c.category || "").toLowerCase() === "agent" && !used.has(c.id),
    );
    const pickAgents = agentPool.slice(
      0,
      Math.max(
        0,
        agentsNeeded - top.filter((x) => (x.category || "").toLowerCase() === "agent").length,
      ),
    );
    for (const a of pickAgents) {
      if (top.length >= 5) break;
      top.push(a);
      used.add(a.id);
    }

    for (const c of scored) {
      if (top.length >= 5) break;
      if (used.has(c.id)) continue;
      top.push(c);
      used.add(c.id);
    }

    return top;
  }, [contacts, voice]);

  // Lock the initial 5 IDs after first load to prevent reshuffling
  useEffect(() => {
    if (lockedIds === null && recs.length > 0) {
      setLockedIds(recs.map((r) => r.id));
    }
  }, [recs]);

  // Stable display list — always shows the same 5 contacts from first load
  const displayRecs = useMemo<Recommendation[]>(() => {
    if (lockedIds === null) return recs;
    return lockedIds
      .map((id) => recs.find((r) => r.id === id))
      .filter((r): r is Recommendation => r != null);
  }, [lockedIds, recs]);

  const stats = useMemo(() => {
    const total = contacts.length;
    const overdue = contacts.filter((c) => isOverdue(c)).length;
    const overdueA = contacts.filter((c) => isAClient(c) && isOverdue(c)).length;
    const agents = contacts.filter((c) => (c.category || "").toLowerCase() === "agent").length;
    return { total, overdue, overdueA, agents };
  }, [contacts]);

  if (!ready) return <div className="page">Loading…</div>;

  const weekday = isWeekdayLocal();

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="h1">Morning</h1>
          <div className="muted" style={{ marginTop: 8 }}>
            <span className="badge">{weekday ? "Weekday focus" : "Weekend (view-only focus)"}</span>{" "}
            <span className="badge">{stats.total} contacts</span>{" "}
            <span className="badge">{stats.overdue} overdue</span>{" "}
            <span className="badge">{stats.overdueA} A-clients overdue</span>{" "}
            <span className="badge">{stats.agents} agents</span>
            {voiceLoaded ? (
              <span className="badge">
                Voice: <strong>{voice?.count ?? 0}</strong> examples
              </span>
            ) : (
              <span className="badge">Voice: loading…</span>
            )}
          </div>

          {voice?.rules?.length ? (
            <div className="muted small" style={{ marginTop: 10 }}>
              <strong>Voice rules:</strong> {voice.rules.slice(0, 3).join(" • ")}
            </div>
          ) : null}
        </div>

        <div className="row">
          <a className="btn" href="/contacts">
            Contacts
          </a>
          <a className="btn" href="/unmatched">
            Unmatched
          </a>
          <button className="btn" onClick={load} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {(error || msg) && (
        <div
          className="card cardPad"
          style={{ borderColor: error ? "rgba(160,0,0,0.25)" : undefined }}
        >
          <div
            style={{
              fontWeight: 900,
              color: error ? "#8a0000" : "#0b6b2a",
              whiteSpace: "pre-wrap",
            }}
          >
            {error || msg}
          </div>
        </div>
      )}

      <div className="section" style={{ marginTop: 14 }}>
        <div className="sectionTitleRow">
          <div className="sectionTitle">Operating rules</div>
          <div className="sectionSub">Daily accountability, without noise.</div>
        </div>

        <div className="row">
          <span className="badge">Top 5 per day</span>
          <span className="badge">Min 2 agents (if available)</span>
          <span className="badge">A-Client never missed</span>
          <span className="badge">Outbound resets cadence</span>
          <span className="badge">Weekday-focused suggestions</span>
        </div>

        {!weekday ? (
          <div className="muted small" style={{ marginTop: 10 }}>
            It's the weekend — this still shows priorities, but your accountability focus is
            weekdays.
          </div>
        ) : null}
      </div>

      <div className="section" style={{ marginTop: 12 }}>
        <div className="sectionTitleRow">
          <div className="sectionTitle">Today's Top 5</div>
          <div className="sectionSub">
            Ranked by overdue + tier + category + days since outbound.
          </div>
        </div>

        <div className="stack">
          {displayRecs.map((c, idx) => {
            const completed = completedIds.has(c.id);
            const agent = (c.category || "").toLowerCase() === "agent";
            const overdue = c.overdue;

            return (
              <div
                key={c.id}
                className="card cardPad"
                style={completed ? { opacity: 0.5, pointerEvents: "none" } : undefined}
              >
                {completed && (
                  <div className="small bold" style={{ color: "#0b6b2a", marginBottom: 8 }}>
                    ✓ Logged today
                  </div>
                )}
                <div
                  className="row"
                  style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}
                >
                  {/* Left: days counter */}
                  <div style={{ textAlign: "center", minWidth: 64, paddingTop: 2 }}>
                    <div style={{
                      fontSize: 28,
                      fontWeight: 900,
                      lineHeight: 1,
                      color: overdue ? "#b91c1c" : "#15803d",
                    }}>
                      {c.days_since_outbound == null ? "∞" : c.days_since_outbound}
                    </div>
                    <div style={{ fontSize: 11, color: "#888", marginTop: 3, fontWeight: 600 }}>
                      {c.days_since_outbound == null ? "never" : "days ago"}
                    </div>
                    <div style={{ fontSize: 11, marginTop: 4, fontWeight: 700, color: overdue ? "#b91c1c" : "#15803d" }}>
                      {overdue ? "overdue" : "on track"}
                    </div>
                  </div>

                  {/* Center: contact info */}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 900, fontSize: 16, wordBreak: "break-word" }}>
                      <span className="badge" style={{ marginRight: 8 }}>#{idx + 1}</span>
                      <a href={`/contacts/${c.id}`}>{c.display_name}</a>
                    </div>

                    <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
                      <span className="badge">{categoryBadge(c)}</span>
                      <span className="badge">Cadence {c.cadence}d</span>
                      {c.last_outbound_at && (
                        <span className="badge muted">Last: {fmtDate(c.last_outbound_at)}{c.last_outbound_channel ? ` • ${c.last_outbound_channel}` : ""}</span>
                      )}
                    </div>

                    {c.last_outbound_summary && (
                      <div style={{ marginTop: 8, fontSize: 13, color: "#555", lineHeight: 1.45 }}>
                        <span style={{ fontWeight: 700, color: "#888", marginRight: 5 }}>Last note:</span>
                        {c.last_outbound_summary}
                      </div>
                    )}

                    <div style={{ marginTop: 10 }} className="cardSoft cardPad">
                      <div className="small muted bold" style={{ marginBottom: 4 }}>Suggested outreach</div>
                      <div className="badge" style={{ marginBottom: 8 }}>
                        via {c.suggested_channel === "in_person" ? "In person" : c.suggested_channel === "social_dm" ? "Social DM" : c.suggested_channel.charAt(0).toUpperCase() + c.suggested_channel.slice(1)}
                      </div>
                      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45, fontSize: 13 }}>
                        {c.suggested_draft}
                      </div>
                    </div>
                  </div>

                  {/* Right: actions */}
                  <div style={{ display: "grid", gap: 8, minWidth: 160 }}>
                    {quickLoggedFor === c.id ? (
                      <>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#15803d", textAlign: "center" }}>
                          ✓ Logged via {c.suggested_channel}
                        </div>
                        <button
                          className="btn"
                          style={{ fontSize: 13 }}
                          onClick={() => { setQuickLoggedFor(null); openLog(c); }}
                        >
                          Add note
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="btn btnPrimary"
                          onClick={() => quickLog(c)}
                          disabled={savingTouch}
                        >
                          Reached out
                        </button>
                        <button
                          className="btn"
                          style={{ fontSize: 13 }}
                          onClick={() => openLog(c)}
                          disabled={savingTouch}
                        >
                          Log with note
                        </button>
                      </>
                    )}
                    <a className="btn" href={`/contacts/${c.id}`} style={{ textDecoration: "none", textAlign: "center", fontSize: 13 }}>
                      Open contact
                    </a>
                  </div>
                </div>

                {loggingFor === c.id && (
                  <div className="section" style={{ marginTop: 12 }}>
                    <div className="sectionTitleRow" style={{ marginBottom: 8 }}>
                      <div className="sectionTitle">Log outreach — {c.display_name}</div>
                    </div>

                    <div className="row" style={{ alignItems: "flex-end" }}>
                      <div style={{ width: 180, minWidth: 160 }}>
                        <div className="small muted bold" style={{ marginBottom: 6 }}>How</div>
                        <select
                          className="select"
                          value={touchChannel}
                          onChange={(e) => setTouchChannel(e.target.value as Touch["channel"])}
                        >
                          <option value="text">Text</option>
                          <option value="email">Email</option>
                          <option value="call">Call</option>
                          <option value="in_person">In person</option>
                          <option value="social_dm">Social DM</option>
                          <option value="other">Other</option>
                        </select>
                      </div>

                      <div style={{ flex: 1, minWidth: 220 }}>
                        <div className="small muted bold" style={{ marginBottom: 6 }}>Note (optional)</div>
                        <textarea
                          className="textarea"
                          value={touchSummary}
                          onChange={(e) => setTouchSummary(e.target.value)}
                          placeholder="What did you say / what came up?"
                          style={{ minHeight: 64 }}
                        />
                      </div>
                    </div>

                    <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
                      <button
                        className="btn"
                        onClick={() => setLoggingFor(null)}
                        disabled={savingTouch}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn btnPrimary"
                        onClick={saveTouch}
                        disabled={savingTouch}
                      >
                        {savingTouch ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {displayRecs.length === 0 ? (
            <div className="card cardPad">
              <div className="muted">No contacts found yet — add a few on Contacts first.</div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}