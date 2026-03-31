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

function localDateLA(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
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
  if (cat === "sphere") {
    if (t === "A") return 60;
    if (t === "B") return 90;
    return 120;
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

  // AI drafts per contact
  const [aiDrafts, setAiDrafts] = useState<Map<string, string>>(new Map());
  const [aiGenerating, setAiGenerating] = useState<Set<string>>(new Set());

  // voice coaching tips + note analysis
  const [coachingTips, setCoachingTips] = useState<{ issue: string; recommendation: string }[]>([]);
  const [noteAnalysis, setNoteAnalysis] = useState<{ observations: string[]; score: number | null } | null>(null);
  const [noteAnalyzing, setNoteAnalyzing] = useState(false);

  // logging touch inline
  const [loggingFor, setLoggingFor] = useState<string | null>(null);
  const [touchChannel, setTouchChannel] = useState<Touch["channel"]>("text");
  const [touchSummary, setTouchSummary] = useState("");
  const [savingTouch, setSavingTouch] = useState(false);
  const [quickLoggedFor, setQuickLoggedFor] = useState<string | null>(null);
  const [quickNoteFor, setQuickNoteFor] = useState<string | null>(null);
  const [quickNote, setQuickNote] = useState("");
  const [quickChannel, setQuickChannel] = useState<Touch["channel"]>("text");

  // accountability stats
  const [streak, setStreak] = useState<number>(0);
  const [yesterdayCount, setYesterdayCount] = useState<number | null>(null);

  // stable list + completed tracking
  const todayKey = `morning-locked-${new Date().toLocaleDateString("en-CA")}`; // YYYY-MM-DD local
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

    // Load coaching tips from user_settings via supabase client
    try {
      const { data } = await supabase
        .from("user_settings")
        .select("voice_coaching_tips")
        .eq("user_id", userId)
        .maybeSingle();
      if (data && (data as any).voice_coaching_tips) {
        setCoachingTips((data as any).voice_coaching_tips);
      }
    } catch {
      // ignore
    }
  }

  async function analyzeNote(uid: string, text: string) {
    if (!text.trim() || text.trim().length < 20) { setNoteAnalysis(null); return; }
    setNoteAnalyzing(true);
    try {
      const res = await fetch("/api/voice/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, text }),
      });
      const j = await res.json();
      if (res.ok) setNoteAnalysis(j);
    } catch {
      // ignore
    } finally {
      setNoteAnalyzing(false);
    }
  }

  async function generateDraft(c: Recommendation) {
    if (!uid || aiGenerating.has(c.id)) return;
    setAiGenerating((prev) => new Set([...prev, c.id]));
    try {
      const res = await fetch("/api/voice/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uid,
          contact_id: c.id,
          channel: c.suggested_channel === "in_person" || c.suggested_channel === "social_dm" ? "text" : c.suggested_channel,
          intent: "check_in",
          length: "short",
          include_question: true,
          include_signature: false,
        }),
      });
      const j = await res.json();
      if (res.ok && j.draft) {
        setAiDrafts((prev) => new Map([...prev, [c.id, j.draft]]));
      }
    } catch {
      // silently fall back to template
    } finally {
      setAiGenerating((prev) => { const next = new Set(prev); next.delete(c.id); return next; });
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
      .eq("archived", false)
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

    // Mark contacts already touched today so they show as completed on return
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { data: todayData } = await supabase
      .from("touches")
      .select("contact_id")
      .eq("direction", "outbound")
      .gte("occurred_at", todayStart.toISOString());

    if (todayData && todayData.length > 0) {
      setCompletedIds(new Set(todayData.map((t: any) => t.contact_id)));
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

    // Compute yesterday touch count + streak from loaded touches
    const yesterdayLA = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return localDateLA(d); })();
    const byDay = new Map<string, Set<string>>();
    for (const t of touches) {
      const d = localDateLA(new Date(t.occurred_at));
      if (!byDay.has(d)) byDay.set(d, new Set());
      byDay.get(d)!.add(t.contact_id);
    }
    setYesterdayCount(byDay.get(yesterdayLA)?.size ?? 0);

    const DAILY_TARGET = 3;
    let s = 0;
    const streakCheck = new Date();
    streakCheck.setDate(streakCheck.getDate() - 1);
    for (let i = 0; i < 30; i++) {
      const dow = streakCheck.getDay();
      const dStr = localDateLA(streakCheck);
      if (dow === 0 || dow === 6) { streakCheck.setDate(streakCheck.getDate() - 1); continue; }
      if ((byDay.get(dStr)?.size ?? 0) >= DAILY_TARGET) s++;
      else break;
      streakCheck.setDate(streakCheck.getDate() - 1);
    }
    setStreak(s);

    setLoading(false);
  }

  function openLog(c: Recommendation) {
    setLoggingFor(c.id);
    setTouchChannel(c.suggested_channel);
    setTouchSummary("");
    setQuickLoggedFor(null);
    setQuickNoteFor(null);
    setQuickNote("");
  }

  async function quickLog(c: Recommendation, note?: string) {
    setSavingTouch(true);
    setError(null);

    const res = await fetch("/api/touches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact_id: c.id,
        channel: quickChannel,
        direction: "outbound",
        intent: "check_in",
        occurred_at: new Date().toISOString(),
        summary: note?.trim() || null,
        source: "manual",
      }),
    });

    setSavingTouch(false);

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(`Insert touch error: ${j?.error || res.statusText}`);
      return;
    }

    setCompletedIds((prev) => new Set([...prev, c.id]));
    setQuickNoteFor(null);
    setQuickNote("");
    setQuickLoggedFor(c.id);
  }

  async function saveTouch() {
    if (!loggingFor) return;
    setSavingTouch(true);
    setError(null);
    setMsg(null);

    const res = await fetch("/api/touches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact_id: loggingFor,
        channel: touchChannel,
        direction: "outbound",
        intent: "check_in",
        occurred_at: new Date().toISOString(),
        summary: touchSummary.trim() ? touchSummary.trim() : null,
        source: "manual",
      }),
    });

    setSavingTouch(false);

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(`Insert touch error: ${j?.error || res.statusText}`);
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
      if (cat === "sphere") score += 50;
      if (cat === "vendor") score += 30;

      const t = (c.tier || "").toUpperCase();
      if (t === "A") score += 40;
      if (t === "B") score += 20;

      if (!weekday) score -= 30;

      const suggested_channel = pickChannel(c);

      return { ...c, cadence, overdue, score, reasons, suggested_channel, suggested_draft: "" };
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
      if (top.length >= 10) break;
      if (used.has(c.id)) continue;
      top.push(c);
      used.add(c.id);
    }

    return top;
  }, [contacts, voice]);

  // Restore locked IDs from localStorage on mount (client-only)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(todayKey);
      if (stored) setLockedIds(JSON.parse(stored));
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lock the initial 5 IDs after first load to prevent reshuffling — persist for the day
  useEffect(() => {
    if (lockedIds === null && recs.length > 0) {
      const ids = recs.slice(0, 5).map((r) => r.id);
      setLockedIds(ids);
      try { localStorage.setItem(todayKey, JSON.stringify(ids)); } catch { /* ignore */ }
    }
  }, [recs]);

  // Stable display list — always shows the same 5 contacts from first load
  const displayRecs = useMemo<Recommendation[]>(() => {
    if (lockedIds === null) return recs.slice(0, 5);
    const resolved = lockedIds
      .map((id) => recs.find((r) => r.id === id))
      .filter((r): r is Recommendation => r != null);
    // If locked IDs no longer resolve (e.g. contacts archived/deleted), reset and fall back to fresh top 5
    if (resolved.length === 0 && recs.length > 0) {
      try { localStorage.removeItem(todayKey); } catch { /* ignore */ }
      return recs.slice(0, 5);
    }
    return resolved;
  }, [lockedIds, recs]);

  // Next 5 after the locked set — shown on demand
  const [bonusLoaded, setBonusLoaded] = useState(false);
  const bonusRecs = useMemo<Recommendation[]>(() => {
    const lockedSet = new Set(lockedIds ?? []);
    // Exclude already-completed contacts so bonus list always has actionable items
    return recs.filter((r) => !lockedSet.has(r.id) && !completedIds.has(r.id)).slice(0, 5);
  }, [recs, lockedIds, completedIds]);

  const allLocked5Done = displayRecs.length > 0 && displayRecs.every((r) => completedIds.has(r.id));

  // Auto-show bonus list if we return to the page with all 5 already done
  useEffect(() => {
    if (allLocked5Done && bonusRecs.length > 0) setBonusLoaded(true);
  }, [allLocked5Done, bonusRecs.length]);

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

      {yesterdayCount !== null && (
        <div
          className="card cardPad"
          style={{
            marginTop: 14,
            borderColor: yesterdayCount >= 3 ? "rgba(0,120,0,0.2)" : "rgba(180,120,0,0.35)",
            background: yesterdayCount >= 3 ? "rgba(0,100,0,0.03)" : "rgba(255,200,0,0.07)",
          }}
        >
          <div className="row" style={{ gap: 20, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ fontWeight: 900, fontSize: 15 }}>
              {streak >= 3
                ? `🔥 ${streak}-day streak`
                : streak > 0
                ? `${streak}-day streak building`
                : "No active streak"}
            </div>
            <div style={{ fontSize: 14, color: yesterdayCount >= 3 ? "#15803d" : "#92400e" }}>
              {yesterdayCount >= 3
                ? `Yesterday: ${yesterdayCount}/3 touches ✓`
                : `Yesterday: ${yesterdayCount}/3 touches — add ${3 - yesterdayCount} extra today to catch up`}
            </div>
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

                    {aiDrafts.has(c.id) ? (
                      <div style={{ marginTop: 10 }} className="cardSoft cardPad">
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span className="small muted bold">Draft</span>
                            <span className="badge" style={{ fontSize: 11 }}>via {c.suggested_channel === "in_person" ? "In person" : c.suggested_channel === "social_dm" ? "Social DM" : c.suggested_channel.charAt(0).toUpperCase() + c.suggested_channel.slice(1)}</span>
                            <span className="badge" style={{ fontSize: 11, color: "#15803d", borderColor: "#86efac" }}>AI</span>
                          </div>
                          <button className="btn" style={{ fontSize: 11, padding: "3px 10px" }} onClick={() => generateDraft(c)} disabled={aiGenerating.has(c.id)}>
                            Regenerate
                          </button>
                        </div>
                        <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.55, fontSize: 13 }}>
                          {aiDrafts.get(c.id)}
                        </div>
                      </div>
                    ) : (
                      <div style={{ marginTop: 10 }}>
                        <button
                          className="btn"
                          style={{ fontSize: 12, padding: "4px 12px" }}
                          onClick={() => generateDraft(c)}
                          disabled={aiGenerating.has(c.id)}
                        >
                          {aiGenerating.has(c.id) ? "Writing draft…" : "Generate draft"}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Right: actions */}
                  <div style={{ display: "grid", gap: 8, minWidth: 160 }}>
                    {quickLoggedFor === c.id ? (
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#15803d", textAlign: "center" }}>
                        ✓ Logged via {quickChannel}
                      </div>
                    ) : quickNoteFor === c.id ? (
                      <>
                        {coachingTips.length > 0 && (
                          <div style={{ fontSize: 12, color: "#666", background: "rgba(0,0,0,0.03)", borderRadius: 6, padding: "7px 10px" }}>
                            <span style={{ fontWeight: 700, color: "#444" }}>Coaching: </span>
                            {coachingTips.slice(0, 2).map((t, i) => (
                              <span key={i}>{t.recommendation}{i < Math.min(coachingTips.length, 2) - 1 ? " · " : ""}</span>
                            ))}
                          </div>
                        )}
                        <select
                          className="select"
                          value={quickChannel}
                          onChange={(e) => setQuickChannel(e.target.value as Touch["channel"])}
                          style={{ fontSize: 13 }}
                        >
                          <option value="text">Text</option>
                          <option value="email">Email</option>
                          <option value="call">Call</option>
                          <option value="in_person">In person</option>
                          <option value="social_dm">Social DM</option>
                          <option value="other">Other</option>
                        </select>
                        <textarea
                          className="textarea"
                          autoFocus
                          value={quickNote}
                          onChange={(e) => setQuickNote(e.target.value)}
                          onBlur={(e) => { if (uid && e.target.value.trim().length >= 20) analyzeNote(uid, e.target.value); }}
                          placeholder="What did you send? (optional)"
                          style={{ minHeight: 64, fontSize: 13, resize: "vertical" }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) quickLog(c, quickNote);
                            if (e.key === "Escape") { setQuickNoteFor(null); setQuickNote(""); setNoteAnalysis(null); }
                          }}
                        />
                        {noteAnalyzing && (
                          <div style={{ fontSize: 12, color: "#888" }}>Analyzing…</div>
                        )}
                        {noteAnalysis && !noteAnalyzing && noteAnalysis.observations.length > 0 && (
                          <div style={{ fontSize: 12, background: "rgba(0,0,0,0.03)", borderRadius: 6, padding: "7px 10px" }}>
                            {noteAnalysis.score !== null && (
                              <span style={{ fontWeight: 700, marginRight: 6, color: noteAnalysis.score >= 7 ? "#15803d" : noteAnalysis.score >= 5 ? "#b45309" : "#b91c1c" }}>
                                {noteAnalysis.score}/10
                              </span>
                            )}
                            {noteAnalysis.observations.map((o, i) => (
                              <span key={i} style={{ color: "#444" }}>{o}{i < noteAnalysis.observations.length - 1 ? " · " : ""}</span>
                            ))}
                          </div>
                        )}
                        <div className="row">
                          <button
                            className="btn btnPrimary"
                            onClick={() => quickLog(c, quickNote)}
                            disabled={savingTouch}
                          >
                            {savingTouch ? "Saving…" : "Save"}
                          </button>
                          <button
                            className="btn"
                            style={{ fontSize: 12 }}
                            onClick={() => { setQuickNoteFor(null); setQuickNote(""); setNoteAnalysis(null); }}
                            disabled={savingTouch}
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <button
                        className="btn btnPrimary"
                        onClick={() => { setQuickNoteFor(c.id); setQuickNote(""); setQuickChannel(c.suggested_channel); setNoteAnalysis(null); }}
                        disabled={savingTouch}
                      >
                        Reached out
                      </button>
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

          {/* Load 5 more — only appears after all 5 are done */}
          {allLocked5Done && bonusRecs.length > 0 && !bonusLoaded && (
            <div className="card cardPad" style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>You finished your Top 5 today.</div>
              <div className="muted small" style={{ marginBottom: 12 }}>Want to keep going? These won't count against your daily goal.</div>
              <button className="btn btnPrimary" onClick={() => setBonusLoaded(true)}>
                Load 5 more
              </button>
            </div>
          )}

          {allLocked5Done && bonusRecs.length === 0 && (
            <div className="card cardPad" style={{ textAlign: "center" }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>All caught up for today.</div>
              <div className="muted small">No more overdue contacts to show. Come back tomorrow.</div>
            </div>
          )}

          {allLocked5Done && bonusLoaded && bonusRecs.length > 0 && (
            <div style={{ paddingLeft: 2, marginBottom: 4 }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>Keep going</span>
              <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>won't count against your daily goal</span>
            </div>
          )}

          {/* Bonus contacts */}
          {bonusLoaded && bonusRecs.map((c, idx) => {
            const completed = completedIds.has(c.id);
            const overdue = c.overdue;
            return (
              <div
                key={c.id}
                className="card cardPad"
                style={{ opacity: completed ? 0.5 : 1, pointerEvents: completed ? "none" : undefined, borderStyle: "dashed" }}
              >
                <div style={{ fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>
                  Bonus #{idx + 1}
                </div>
                {completed && (
                  <div className="small bold" style={{ color: "#0b6b2a", marginBottom: 8 }}>✓ Logged today</div>
                )}
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                  <div style={{ textAlign: "center", minWidth: 64, paddingTop: 2 }}>
                    <div style={{ fontSize: 28, fontWeight: 900, lineHeight: 1, color: overdue ? "#b91c1c" : "#15803d" }}>
                      {c.days_since_outbound == null ? "∞" : c.days_since_outbound}
                    </div>
                    <div style={{ fontSize: 11, color: "#888", marginTop: 3, fontWeight: 600 }}>
                      {c.days_since_outbound == null ? "never" : "days ago"}
                    </div>
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 900, fontSize: 15 }}>
                      <a href={`/contacts/${c.id}`}>{c.display_name}</a>
                    </div>
                    <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
                      <span className="badge">{categoryBadge(c)}</span>
                      <span className="badge">Cadence {c.cadence}d</span>
                      {c.last_outbound_at && <span className="badge muted">Last: {fmtDate(c.last_outbound_at)}</span>}
                    </div>
                    {c.last_outbound_summary && (
                      <div style={{ marginTop: 6, fontSize: 13, color: "#555" }}>
                        <span style={{ fontWeight: 700, color: "#888", marginRight: 5 }}>Last note:</span>
                        {c.last_outbound_summary}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "grid", gap: 8, minWidth: 140 }}>
                    {quickNoteFor === c.id ? (
                      <>
                        <textarea
                          className="textarea"
                          autoFocus
                          value={quickNote}
                          onChange={(e) => setQuickNote(e.target.value)}
                          placeholder="What did you send?"
                          style={{ minHeight: 72, fontSize: 13, resize: "vertical" }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) quickLog(c, quickNote);
                            if (e.key === "Escape") { setQuickNoteFor(null); setQuickNote(""); }
                          }}
                        />
                        <button className="btn btnPrimary" onClick={() => quickLog(c, quickNote)} disabled={savingTouch}>
                          {savingTouch ? "Saving…" : "Save"}
                        </button>
                        <button className="btn" style={{ fontSize: 12 }} onClick={() => quickLog(c)} disabled={savingTouch}>
                          Skip note
                        </button>
                      </>
                    ) : quickLoggedFor === c.id ? (
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#15803d", textAlign: "center" }}>
                        ✓ Logged via {quickChannel}
                      </div>
                    ) : (
                      <button
                        className="btn btnPrimary"
                        onClick={() => { setQuickNoteFor(c.id); setQuickNote(""); }}
                        disabled={savingTouch}
                      >
                        Reached out
                      </button>
                    )}
                    <a className="btn" href={`/contacts/${c.id}`} style={{ textDecoration: "none", textAlign: "center", fontSize: 13 }}>
                      Open contact
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}