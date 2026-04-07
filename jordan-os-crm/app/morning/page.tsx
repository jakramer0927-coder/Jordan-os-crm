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
  phone: string | null;
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

function weekdaysElapsedToday(now = new Date()): number {
  const day = now.getDay();
  if (day === 0 || day === 6) return 5;
  return day; // Mon=1 … Fri=5
}

function startOfWeekMondayLocal(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() - ((day + 6) % 7));
  return d;
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
  if (cat === "sphere") {
    if (t === "A") return 30;
    if (t === "B") return 60;
    return 90;
  }
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
  if (cat === "sphere") return "text";
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

  const sphereValues = [
    "Just wanted to check in — hope everything's going well on your end.",
    "Been thinking about you — wanted to say hi and stay in touch.",
    "Quick note to reconnect — it's been a while and I've been meaning to reach out.",
  ];

  const sphereAsks = [
    "How's life treating you?",
    "Anything new and exciting happening for you?",
    "Would love to grab coffee or a quick call whenever works for you.",
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
  } else if (cat === "sphere") {
    value = choose(sphereValues, sphereValues[0]);
    ask = choose(sphereAsks, sphereAsks[0]);
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

type MorningRules = {
  totalRecs: number;
  minAgents: number;
  minClients: number;
  minSphere: number;
};

const DEFAULT_RULES: MorningRules = {
  totalRecs: 5,
  minAgents: 2,
  minClients: 0,
  minSphere: 0,
};

const RULES_KEY = "morning_rules_v1";

function loadRules(): MorningRules {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (!raw) return DEFAULT_RULES;
    const parsed = JSON.parse(raw) as Partial<MorningRules>;
    return { ...DEFAULT_RULES, ...parsed };
  } catch {
    return DEFAULT_RULES;
  }
}

function saveRules(r: MorningRules) {
  try { localStorage.setItem(RULES_KEY, JSON.stringify(r)); } catch { /* ignore */ }
}

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
  const [touchIntent, setTouchIntent] = useState<TouchIntent>("check_in");
  const [touchSummary, setTouchSummary] = useState("");
  const [touchSource, setTouchSource] = useState("manual");
  const [touchLink, setTouchLink] = useState("");
  const [savingTouch, setSavingTouch] = useState(false);

  // voice draft in log panel
  const [touchAsk, setTouchAsk] = useState("");
  const [touchDraft, setTouchDraft] = useState("");
  const [touchDraftBusy, setTouchDraftBusy] = useState(false);
  const [touchDraftCopied, setTouchDraftCopied] = useState(false);
  const [touchSuggestBusy, setTouchSuggestBusy] = useState(false);
  const [touchSuggestMeta, setTouchSuggestMeta] = useState<{ intent: string; confidence: number; reason: string } | null>(null);

  // stable list + completed tracking
  const [lockedIds, setLockedIds] = useState<string[] | null>(null);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());

  // accountability strip
  const [todayCount, setTodayCount] = useState(0);
  const [wtdCount, setWtdCount] = useState(0);

  // operating rules — load synchronously on first render to avoid re-render loop
  const [rules, setRules] = useState<MorningRules>(() => {
    if (typeof window === "undefined") return DEFAULT_RULES;
    return loadRules();
  });
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rulesReady, setRulesReady] = useState(false);

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

  async function loadVoiceProfile(_userId: string) {
    try {
      const res = await fetch(`/api/voice/profile?limit=120&minLen=140`);
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
      .select("id, display_name, category, tier, client_type, email, phone, created_at")
      .neq("archived", true)
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

    const ids = base.map((c) => c.id);
    const { data: tData, error: tErr } = await supabase
      .from("touches")
      .select(
        "id, contact_id, channel, direction, occurred_at, intent, summary, source, source_link",
      )
      .in("contact_id", ids)
      .eq("direction", "outbound")
      .order("occurred_at", { ascending: false })
      .limit(8000);

    if (tErr) {
      setError(`Touches fetch error: ${tErr.message}`);
      const mergedFail: ContactWithLastOutbound[] = base.map((c) => ({
        ...c,
        last_outbound_at: null,
        last_outbound_channel: null,
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
        days_since_outbound: last ? daysSince(last.occurred_at) : null,
      };
    });

    setContacts(merged);

    // Accountability strip counts
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const weekStart = startOfWeekMondayLocal(new Date());

    const [{ count: tc }, { count: wc }] = await Promise.all([
      supabase.from("touches").select("id", { count: "exact", head: true }).eq("direction", "outbound").gte("occurred_at", todayStart.toISOString()),
      supabase.from("touches").select("id", { count: "exact", head: true }).eq("direction", "outbound").gte("occurred_at", weekStart.toISOString()),
    ]);
    setTodayCount(tc ?? 0);
    setWtdCount(wc ?? 0);

    setLoading(false);
  }

  function openLog(c: Recommendation) {
    setLoggingFor(c.id);
    setTouchChannel(c.suggested_channel);
    setTouchIntent("check_in");
    setTouchSummary("");
    setTouchSource("manual");
    setTouchLink("");
    setTouchAsk("");
    setTouchDraft("");
    setTouchDraftCopied(false);
    setTouchSuggestMeta(null);
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
      intent: touchIntent,
      occurred_at: new Date().toISOString(),
      summary: touchSummary.trim() ? touchSummary.trim() : null,
      source: touchSource.trim() ? touchSource.trim() : null,
      source_link: touchLink.trim() ? touchLink.trim() : null,
    });

    setSavingTouch(false);

    if (insErr) {
      setError(`Insert touch error: ${insErr.message}`);
      return;
    }

    // Mark as completed — do NOT reload (this is what caused reshuffling)
    setCompletedIds((prev) => new Set([...prev, loggingFor]));
    setTodayCount((n) => n + 1);
    setWtdCount((n) => n + 1);
    setMsg("Touch logged ✓");
    setLoggingFor(null);
  }

  // Debounced suggest-intent when user types a prompt in the log panel
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;

    async function run() {
      if (!uid || !loggingFor) return;
      const text = touchAsk.trim();
      if (text.length < 10) { setTouchSuggestMeta(null); return; }

      setTouchSuggestBusy(true);
      try {
        const ch = (touchChannel === "email" || touchChannel === "text") ? touchChannel : "email";
        const res = await fetch("/api/voice/suggest-intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contact_id: loggingFor, channel: ch, ask: text }),
        });
        const j = await res.json();
        if (res.ok) {
          setTouchSuggestMeta({ intent: j.intent || "other", confidence: j.confidence ?? 0.5, reason: String(j.reason || "") });
        }
      } catch { /* ignore */ }
      finally { setTouchSuggestBusy(false); }
    }

    t = setTimeout(run, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touchAsk, uid, loggingFor, touchChannel]);

  async function generateTouchDraft() {
    if (!uid || !loggingFor || !touchAsk.trim()) return;
    setTouchDraftBusy(true);
    try {
      const ch = (touchChannel === "email" || touchChannel === "text") ? touchChannel : "email";
      const res = await fetch("/api/voice/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: loggingFor,
          channel: ch,
          intent: touchSuggestMeta?.intent || "check_in",
          length: "short",
          ask: touchAsk.trim(),
          include_question: true,
          include_signature: touchChannel === "email",
        }),
      });
      const j = await res.json();
      if (res.ok) setTouchDraft(j.draft || "");
    } catch { /* ignore */ }
    finally { setTouchDraftBusy(false); }
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
    const { totalRecs, minAgents, minClients, minSphere } = rules;

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
      if (d == null) score += 200; // never reached out — boost above minimally-overdue contacts
      score += (d ?? cadence) * 2;

      const cat = (c.category || "").toLowerCase();
      if (cat === "agent") score += 60;
      if (cat === "developer") score += 40;
      if (cat === "client") score += 80;
      if (cat === "vendor") score += 30;
      if (cat === "sphere") score += 50;

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
      if (top.length >= totalRecs) break;
      top.push(c);
      used.add(c.id);
    }

    const guaranteedSlots: Array<{ cat: string; needed: number }> = [
      { cat: "agent", needed: minAgents },
      { cat: "client", needed: minClients },
      { cat: "sphere", needed: minSphere },
    ];
    for (const { cat, needed } of guaranteedSlots) {
      if (needed <= 0) continue;
      // Only guarantee overdue contacts — don't force recently-contacted people in
      const pool = scored.filter((c) => (c.category || "").toLowerCase() === cat && !used.has(c.id) && c.overdue);
      const already = top.filter((x) => (x.category || "").toLowerCase() === cat).length;
      const picks = pool.slice(0, Math.max(0, needed - already));
      for (const p of picks) {
        if (top.length >= totalRecs) break;
        top.push(p);
        used.add(p.id);
      }
    }

    // Fill remaining slots — only contacts at least 50% through their cadence
    // (or never contacted). Never pad with recently-touched people.
    for (const c of scored) {
      if (top.length >= totalRecs) break;
      if (used.has(c.id)) continue;
      const isNeverContacted = c.days_since_outbound == null;
      const isApproachingDue = c.days_since_outbound != null && c.days_since_outbound >= c.cadence * 0.5;
      if (!isNeverContacted && !isApproachingDue) continue;
      top.push(c);
      used.add(c.id);
    }

    return top;
  }, [contacts, voice, rules]);

  // Reset locked list when user explicitly changes rules (not on mount)
  useEffect(() => {
    if (!rulesReady) { setRulesReady(true); return; }
    setLockedIds(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules]);

  useEffect(() => {
    if (lockedIds === null && recs.length > 0) {
      setLockedIds(recs.map((r) => r.id));
    }
  }, [recs, lockedIds]);

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
        <div className="rowBetween" style={{ marginBottom: 10 }}>
          <div>
            <div className="sectionTitle">Operating rules</div>
            <div className="sectionSub">Daily accountability, without noise.</div>
          </div>
          <button
            className="btn"
            style={{ fontSize: 12, padding: "2px 10px", flexShrink: 0 }}
            onClick={() => setRulesOpen((o) => !o)}
          >
            {rulesOpen ? "Done" : "Edit"}
          </button>
        </div>

        {rulesOpen ? (
          <div className="card cardPad" style={{ marginTop: 10 }}>
            <div className="row" style={{ flexWrap: "wrap", gap: 20, alignItems: "flex-end" }}>
              {(
                [
                  { key: "totalRecs", label: "Outreach per day", min: 1, max: 20 },
                  { key: "minAgents", label: "Min agents", min: 0, max: 10 },
                  { key: "minClients", label: "Min clients", min: 0, max: 10 },
                  { key: "minSphere", label: "Min sphere", min: 0, max: 10 },
                ] as Array<{ key: keyof MorningRules; label: string; min: number; max: number }>
              ).map(({ key, label, min, max }) => (
                <div key={key} className="field" style={{ minWidth: 120 }}>
                  <div className="label">{label}</div>
                  <input
                    className="input"
                    type="number"
                    min={min}
                    max={max}
                    value={rules[key]}
                    onChange={(e) => {
                      const val = Math.max(min, Math.min(max, Number(e.target.value) || min));
                      const next = { ...rules, [key]: val };
                      setRules(next);
                      saveRules(next);
                    }}
                    style={{ width: 72 }}
                  />
                </div>
              ))}
            </div>
            <div className="muted small" style={{ marginTop: 10 }}>
              Changes apply immediately and persist across sessions.
            </div>
          </div>
        ) : (
          <div className="row">
            <span className="badge">Top {rules.totalRecs} per day</span>
            {rules.minAgents > 0 && <span className="badge">Min {rules.minAgents} agents</span>}
            {rules.minClients > 0 && <span className="badge">Min {rules.minClients} clients</span>}
            {rules.minSphere > 0 && <span className="badge">Min {rules.minSphere} sphere</span>}
            <span className="badge">A-Client never missed</span>
            <span className="badge">Outbound resets cadence</span>
            <span className="badge">Weekday-focused suggestions</span>
          </div>
        )}

        {!weekday ? (
          <div className="muted small" style={{ marginTop: 10 }}>
            It's the weekend — this still shows priorities, but your accountability focus is
            weekdays.
          </div>
        ) : null}
      </div>

      {/* ── Accountability strip ── */}
      <div className="card cardPad" style={{ marginTop: 12 }}>
        <div className="rowBetween" style={{ flexWrap: "wrap", gap: 16, alignItems: "center" }}>
          <div className="row" style={{ gap: 28, flexWrap: "wrap" }}>
            <div>
              <div className="label" style={{ marginBottom: 2 }}>Today</div>
              <div style={{ fontWeight: 900, fontSize: 28, lineHeight: 1, color: todayCount >= rules.totalRecs ? "#0b6b2a" : "var(--ink)" }}>
                {todayCount}
                <span style={{ fontWeight: 400, fontSize: 13, color: "rgba(18,18,18,.4)", marginLeft: 4 }}>/ {rules.totalRecs}</span>
              </div>
              <div style={{ fontSize: 12, marginTop: 2, fontWeight: 700, color: todayCount >= rules.totalRecs ? "#0b6b2a" : "rgba(18,18,18,.5)" }}>
                {todayCount >= rules.totalRecs ? "Goal hit ✓" : `${rules.totalRecs - todayCount} to go`}
              </div>
            </div>

            <div style={{ width: 1, height: 44, background: "rgba(0,0,0,.08)", flexShrink: 0, alignSelf: "center" }} />

            <div>
              <div className="label" style={{ marginBottom: 2 }}>This week</div>
              <div style={{ fontWeight: 900, fontSize: 28, lineHeight: 1 }}>{wtdCount}</div>
              {(() => {
                const expected = weekdaysElapsedToday() * rules.totalRecs;
                const diff = wtdCount - expected;
                const behind = diff < 0;
                return (
                  <div style={{ fontSize: 12, marginTop: 2, fontWeight: 700, color: behind ? "#8a0000" : "#0b6b2a" }}>
                    {behind ? `${Math.abs(diff)} behind pace` : `+${diff} ahead`}
                  </div>
                );
              })()}
            </div>
          </div>

          <a href="/insights" className="btn" style={{ textDecoration: "none", fontSize: 12 }}>
            Full report →
          </a>
        </div>
      </div>

      <div className="section" style={{ marginTop: 12 }}>
        <div className="sectionTitleRow">
          <div className="sectionTitle">Today's Top {rules.totalRecs}</div>
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
                <div className="recCardLayout">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      className="row"
                      style={{ justifyContent: "space-between", alignItems: "baseline" }}
                    >
                      <div style={{ fontWeight: 900, fontSize: 16, wordBreak: "break-word" }}>
                        <span className="badge" style={{ marginRight: 10 }}>
                          #{idx + 1}
                        </span>
                        <a href={`/contacts/${c.id}`}>{c.display_name}</a>
                      </div>

                      <div className="muted small">
                        Last outbound: <span className="bold">{fmtDate(c.last_outbound_at)}</span>
                        {c.last_outbound_channel ? ` • ${c.last_outbound_channel}` : ""}
                      </div>
                    </div>

                    <div className="row" style={{ marginTop: 10 }}>
                      <span className="badge">{categoryBadge(c)}</span>
                      <span className="badge">Cadence {c.cadence}d</span>
                      {c.days_since_outbound == null ? (
                        <span className="badge">Never outbound</span>
                      ) : (
                        <span className="badge">{c.days_since_outbound}d since</span>
                      )}
                      <span className="badge">{overdue ? "Overdue" : "On track"}</span>
                      {agent ? <span className="badge">Agent touch</span> : null}
                    </div>

                    {(c.email || c.phone) && (
                      <div className="muted small" style={{ marginTop: 6, display: "flex", gap: 14, flexWrap: "wrap" }}>
                        {c.email && <a href={`mailto:${c.email}`} style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: 2 }}>{c.email}</a>}
                        {c.phone && <a href={`tel:${c.phone}`} style={{ color: "inherit", textDecoration: "underline", textUnderlineOffset: 2 }}>{c.phone}</a>}
                      </div>
                    )}

                    <div style={{ marginTop: 10 }} className="cardSoft cardPad">
                      <div className="small muted bold" style={{ marginBottom: 6 }}>
                        Suggested outreach (Jordan voice)
                      </div>
                      <div className="row">
                        <span className="badge">Channel: {c.suggested_channel}</span>
                        <span className="badge">Intent: check_in</span>
                      </div>

                      <div style={{ marginTop: 10, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>
                        {c.suggested_draft}
                      </div>
                    </div>
                  </div>

                  <div className="recCardActions">
                    <a className="btn" href={`/contacts/${c.id}`}>
                      Open contact
                    </a>
                    <button className="btn btnPrimary" onClick={() => openLog(c)}>
                      Log outbound touch
                    </button>
                  </div>
                </div>

                {loggingFor === c.id && (
                  <div className="section" style={{ marginTop: 12 }}>
                    <div className="sectionTitleRow" style={{ marginBottom: 8 }}>
                      <div className="sectionTitle">Log outbound touch</div>
                      <div className="sectionSub">{c.display_name}</div>
                    </div>

                    <div className="row">
                      <div style={{ width: 200, minWidth: 180 }}>
                        <div className="small muted bold" style={{ marginBottom: 6 }}>
                          Channel
                        </div>
                        <select
                          className="select"
                          value={touchChannel}
                          onChange={(e) => setTouchChannel(e.target.value as Touch["channel"])}
                        >
                          <option value="email">email</option>
                          <option value="text">text</option>
                          <option value="call">call</option>
                          <option value="in_person">in_person</option>
                          <option value="social_dm">social_dm</option>
                          <option value="other">other</option>
                        </select>
                      </div>

                      <div style={{ width: 260, minWidth: 220 }}>
                        <div className="small muted bold" style={{ marginBottom: 6 }}>
                          Intent
                        </div>
                        <select
                          className="select"
                          value={touchIntent}
                          onChange={(e) => setTouchIntent(e.target.value as TouchIntent)}
                        >
                          <option value="check_in">check_in</option>
                          <option value="referral_ask">referral_ask</option>
                          <option value="review_ask">review_ask</option>
                          <option value="deal_followup">deal_followup</option>
                          <option value="collaboration">collaboration</option>
                          <option value="event_invite">event_invite</option>
                          <option value="other">other</option>
                        </select>
                      </div>

                      <div style={{ flex: 1, minWidth: 220 }}>
                        <div className="small muted bold" style={{ marginBottom: 6 }}>
                          Source
                        </div>
                        <input
                          className="input"
                          value={touchSource}
                          onChange={(e) => setTouchSource(e.target.value)}
                          placeholder="manual / gmail / sms"
                        />
                      </div>
                    </div>

                    <div className="row" style={{ marginTop: 10 }}>
                      <div style={{ flex: 1, minWidth: 260 }}>
                        <div className="small muted bold" style={{ marginBottom: 6 }}>
                          Link (optional)
                        </div>
                        <input
                          className="input"
                          value={touchLink}
                          onChange={(e) => setTouchLink(e.target.value)}
                          placeholder="thread link / calendar link"
                        />
                      </div>
                    </div>

                    <div style={{ marginTop: 10 }}>
                      <div className="small muted bold" style={{ marginBottom: 6 }}>
                        Summary (optional)
                      </div>
                      <textarea
                        className="textarea"
                        value={touchSummary}
                        onChange={(e) => setTouchSummary(e.target.value)}
                        placeholder="Quick note about what you sent / what happened"
                      />
                    </div>

                    {/* Voice draft suggestion */}
                    <div style={{ marginTop: 10 }}>
                      <div className="small muted bold" style={{ marginBottom: 6 }}>
                        Draft a message <span style={{ fontWeight: 400 }}>(optional — generates in your voice)</span>
                      </div>
                      <div className="row" style={{ gap: 8 }}>
                        <input
                          className="input"
                          style={{ flex: 1 }}
                          value={touchAsk}
                          onChange={(e) => setTouchAsk(e.target.value)}
                          placeholder='e.g. "Check in, see how the house is going"'
                        />
                        <button
                          className="btn btnPrimary"
                          type="button"
                          onClick={generateTouchDraft}
                          disabled={touchDraftBusy || !touchAsk.trim()}
                        >
                          {touchDraftBusy ? "Writing…" : "Draft"}
                        </button>
                      </div>

                      <div className="muted small" style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                        <span className="kicker">Suggested intent</span>
                        {touchSuggestBusy ? (
                          <span>Thinking…</span>
                        ) : touchSuggestMeta ? (
                          <>
                            <span style={{ fontWeight: 900, color: "var(--ink)" }}>{touchSuggestMeta.intent.replace(/_/g, " ")}</span>
                            <span>({Math.round(touchSuggestMeta.confidence * 100)}%)</span>
                            {touchSuggestMeta.reason ? <span>• {touchSuggestMeta.reason}</span> : null}
                          </>
                        ) : (
                          <span>Type a prompt above to get a suggested intent.</span>
                        )}
                      </div>

                      {touchDraft ? (
                        <div className="cardSoft cardPad" style={{ marginTop: 10 }}>
                          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
                            <button
                              className="btn"
                              type="button"
                              style={{ fontSize: 12, padding: "2px 10px" }}
                              onClick={async () => {
                                await navigator.clipboard.writeText(touchDraft);
                                setTouchDraftCopied(true);
                                setTimeout(() => setTouchDraftCopied(false), 1200);
                              }}
                            >
                              {touchDraftCopied ? "Copied" : "Copy"}
                            </button>
                          </div>
                          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45, fontSize: 14 }}>{touchDraft}</div>
                        </div>
                      ) : null}
                    </div>

                    <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
                      <div className="muted small">Outbound touches reset cadence.</div>
                      <div className="row">
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