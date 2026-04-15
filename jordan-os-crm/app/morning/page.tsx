"use client";

import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

type TouchIntent =
  | "check_in"
  | "follow_up"
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
  days_since_outbound: number | null;
  last_inbound_at: string | null;
  active_deals: number;
  birthday: string | null;
  close_anniversary: string | null;
  move_in_date: string | null;
};

type FollowUp = {
  id: string;
  contact_id: string;
  due_date: string;
  note: string | null;
  contacts: { id: string; display_name: string; category: string; tier: string | null } | null;
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

function upcomingMilestones(c: ContactWithLastOutbound): { label: string; daysAway: number }[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const results: { label: string; daysAway: number }[] = [];
  const checkRecurring = (dateStr: string | null, label: string) => {
    if (!dateStr) return;
    const d = new Date(dateStr);
    const thisYear = new Date(today.getFullYear(), d.getMonth(), d.getDate());
    const next = thisYear >= today ? thisYear : new Date(today.getFullYear() + 1, d.getMonth(), d.getDate());
    const days = Math.ceil((next.getTime() - today.getTime()) / 86400000);
    if (days <= 14) results.push({ label, daysAway: days });
  };
  checkRecurring(c.birthday, "Birthday");
  checkRecurring(c.close_anniversary, "Close anniversary");
  if (c.move_in_date) {
    const d = new Date(c.move_in_date);
    const days = Math.ceil((d.getTime() - today.getTime()) / 86400000);
    if (days >= 0 && days <= 14) results.push({ label: "Move-in", daysAway: days });
  }
  return results;
}

function syncAgo(iso: string | null): { label: string; stale: boolean } {
  if (!iso) return { label: "never", stale: true };
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return { label: `${mins}m ago`, stale: false };
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return { label: `${hrs}h ago`, stale: hrs >= 4 };
  return { label: `${Math.floor(hrs / 24)}d ago`, stale: true };
}

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
const LOCK_KEY = "morning_lock_v1";

function todayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function loadLockedIds(): string[] | null {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (!raw) return null;
    const { date, ids } = JSON.parse(raw) as { date: string; ids: string[] };
    if (date !== todayDateString()) return null;
    return ids;
  } catch {
    return null;
  }
}

function saveLockedIds(ids: string[]) {
  try {
    localStorage.setItem(LOCK_KEY, JSON.stringify({ date: todayDateString(), ids }));
  } catch { /* ignore */ }
}

function clearLockedIds() {
  try { localStorage.removeItem(LOCK_KEY); } catch { /* ignore */ }
}

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

  // stable list + completed tracking — persisted per calendar day
  const [lockedIds, setLockedIds] = useState<string[] | null>(() => {
    if (typeof window === "undefined") return null;
    return loadLockedIds();
  });
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());

  // AI-generated drafts keyed by contact ID
  const [aiDrafts, setAiDrafts] = useState<Record<string, string>>({});
  const [draftsGenerating, setDraftsGenerating] = useState<Set<string>>(new Set());
  // Per-contact intent selection
  const [draftIntents, setDraftIntents] = useState<Record<string, TouchIntent>>({});

  // Follow-ups
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [completingFollowUp, setCompletingFollowUp] = useState<string | null>(null);
  // Remind-me form (attached to touch log)
  const [remindOpen, setRemindOpen] = useState(false);
  const [remindDate, setRemindDate] = useState("");
  const [remindNote, setRemindNote] = useState("");

  // Bulk touch logging
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkChannel, setBulkChannel] = useState<Touch["channel"]>("email");
  const [bulkIntent, setBulkIntent] = useState<TouchIntent>("check_in");
  const [bulkSummary, setBulkSummary] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);

  // accountability strip
  const [todayCount, setTodayCount] = useState(0);
  const [wtdCount, setWtdCount] = useState(0);

  // sync health
  const [syncGmail, setSyncGmail] = useState<string | null>(null);
  const [syncCalendar, setSyncCalendar] = useState<string | null>(null);

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
    // Clear the lock so a fresh top-N is picked from the new data
    setLockedIds(null);
    clearLockedIds();

    const user = await requireSession();
    if (!user) { setLoading(false); return; }

    // Fetch contacts+touches+counts, voice profile, sync status, and follow-ups in parallel
    const [contactsRes, syncRes, followUpsRes] = await Promise.all([
      fetch("/api/morning/contacts"),
      fetch("/api/sync/status"),
      fetch("/api/follow-ups?due_today=1"),
      voiceLoaded ? Promise.resolve() : loadVoiceProfile(user.id),
    ]);

    if (syncRes.ok) {
      const sj = await syncRes.json().catch(() => ({}));
      setSyncGmail(sj.gmail ?? null);
      setSyncCalendar(sj.calendar ?? null);
    }

    if (followUpsRes.ok) {
      const fj = await followUpsRes.json().catch(() => ({}));
      setFollowUps((fj.follow_ups ?? []) as FollowUp[]);
    }

    if (!contactsRes.ok) {
      const j = await contactsRes.json().catch(() => ({}));
      setError(`Load error: ${(j as any).error ?? contactsRes.statusText}`);
      setLoading(false);
      return;
    }

    const { contacts: merged, todayCount: tc, wtdCount: wc } = await contactsRes.json();

    setContacts((merged ?? []) as ContactWithLastOutbound[]);
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

  async function completeFollowUp(id: string) {
    setCompletingFollowUp(id);
    await fetch("/api/follow-ups", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setFollowUps((prev) => prev.filter((f) => f.id !== id));
    setCompletingFollowUp(null);
  }

  async function saveReminder(contactId: string) {
    if (!remindDate) return;
    await fetch("/api/follow-ups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contact_id: contactId, due_date: remindDate, note: remindNote.trim() || null }),
    });
    setRemindOpen(false);
    setRemindDate("");
    setRemindNote("");
    setMsg("Reminder saved ✓");
  }

  async function saveBulkTouch() {
    if (displayRecs.length === 0) return;
    setBulkSaving(true);
    setBulkMsg(null);

    const now = new Date().toISOString();
    const rows = displayRecs.map((c) => ({
      contact_id: c.id,
      channel: bulkChannel,
      direction: "outbound" as const,
      intent: bulkIntent,
      occurred_at: now,
      summary: bulkSummary.trim() || null,
      source: "manual",
    }));

    const { error } = await supabase.from("touches").insert(rows);
    setBulkSaving(false);

    if (error) { setBulkMsg(`Error: ${error.message}`); return; }

    const ids = displayRecs.map((c) => c.id);
    setCompletedIds((prev) => new Set([...prev, ...ids]));
    setTodayCount((n) => n + ids.length);
    setWtdCount((n) => n + ids.length);
    setBulkMsg(`${ids.length} touches logged ✓`);
    setBulkOpen(false);
    setBulkSummary("");
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

      // Recency protection: contacts touched in last 3 days are deprioritized
      const recentlyTouched = d != null && d <= 3;
      if (recentlyTouched) reasons.push("Touched recently — deprioritized");

      // Inbound recency: if they replied recently, less urgent to reach out
      const daysSinceInbound = c.last_inbound_at
        ? Math.max(0, Math.floor((Date.now() - new Date(c.last_inbound_at).getTime()) / 86400000))
        : null;
      const inboundRecent7 = daysSinceInbound != null && daysSinceInbound <= 7;
      const inboundRecent3 = daysSinceInbound != null && daysSinceInbound <= 3;

      // Cadence ratio: normalized urgency (1.0 = exactly at cadence, >1 = overdue)
      const ratio = (d ?? cadence) / cadence;

      let score = ratio * 100;

      // Never contacted gets a meaningful boost
      if (d == null) score += 30;

      // A-client always floats to top
      if (isAClient(c)) score += 100;

      // Category priority weights
      const cat = (c.category || "").toLowerCase();
      if (cat === "client") score += 20;
      if (cat === "agent") score += 15;
      if (cat === "sphere") score += 10;
      if (cat === "developer") score += 10;
      if (cat === "vendor") score += 5;

      // Tier weights
      const t = (c.tier || "").toUpperCase();
      if (t === "A") score += 20;
      if (t === "B") score += 10;

      // Inbound recency reduces urgency
      if (inboundRecent3) { score -= 40; reasons.push("Replied within 3 days — less urgent"); }
      else if (inboundRecent7) { score -= 20; reasons.push("Replied within 7 days"); }

      // Recency protection: sink recently-touched contacts
      if (recentlyTouched) score = -999;

      const suggested_channel = pickChannel(c);

      return { ...c, cadence, overdue, score, reasons, suggested_channel };
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
    // Category diversity cap: max 2 per category in fill phase.
    const fillCategoryCounts: Record<string, number> = {};
    for (const c of top) {
      const cat = (c.category || "other").toLowerCase();
      fillCategoryCounts[cat] = (fillCategoryCounts[cat] ?? 0) + 1;
    }

    for (const c of scored) {
      if (top.length >= totalRecs) break;
      if (used.has(c.id)) continue;
      if (c.score === -999) continue; // recency-protected
      const isNeverContacted = c.days_since_outbound == null;
      const isApproachingDue = c.days_since_outbound != null && c.days_since_outbound >= c.cadence * 0.5;
      if (!isNeverContacted && !isApproachingDue) continue;
      const cat = (c.category || "other").toLowerCase();
      if ((fillCategoryCounts[cat] ?? 0) >= 2) continue;
      top.push(c);
      used.add(c.id);
      fillCategoryCounts[cat] = (fillCategoryCounts[cat] ?? 0) + 1;
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
      const ids = recs.map((r) => r.id);
      setLockedIds(ids);
      saveLockedIds(ids);
      generateDrafts(recs);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recs, lockedIds]);

  async function generateDrafts(contacts: Recommendation[]) {
    const pending = new Set(contacts.map((c) => c.id));
    setDraftsGenerating(pending);
    await Promise.all(
      contacts.map(async (c) => {
        try {
          const res = await fetch("/api/voice/draft", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contact_id: c.id,
              channel: c.suggested_channel,
              intent: "check_in",
              length: "short",
            }),
          });
          const j = await res.json();
          if (res.ok && j.draft) {
            setAiDrafts((prev) => ({ ...prev, [c.id]: j.draft }));
          }
        } catch {
          // silently fall back to template
        } finally {
          setDraftsGenerating((prev) => { const next = new Set(prev); next.delete(c.id); return next; });
        }
      })
    );
  }

  async function regenerateDraft(c: Recommendation, intent?: TouchIntent) {
    const resolvedIntent = intent ?? draftIntents[c.id] ?? "check_in";
    setDraftsGenerating((prev) => new Set(prev).add(c.id));
    try {
      const res = await fetch("/api/voice/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: c.id,
          channel: c.suggested_channel,
          intent: resolvedIntent,
          length: "short",
        }),
      });
      const j = await res.json();
      if (res.ok && j.draft) {
        setAiDrafts((prev) => ({ ...prev, [c.id]: j.draft }));
      }
    } catch {
      // ignore
    } finally {
      setDraftsGenerating((prev) => { const next = new Set(prev); next.delete(c.id); return next; });
    }
  }

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
  const lateNudge = (() => {
    if (!weekday) return false;
    if (todayCount >= rules.totalRecs) return false;
    const hour = new Date().getHours();
    return hour >= 15; // 3pm+
  })();

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

          {(syncGmail !== undefined || syncCalendar !== undefined) && (() => {
            const g = syncAgo(syncGmail);
            const c = syncAgo(syncCalendar);
            return (
              <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 6 }}>
                <span className="badge" style={{ fontSize: 11, color: g.stale ? "#8a0000" : "rgba(18,18,18,.5)", borderColor: g.stale ? "rgba(200,0,0,.25)" : undefined }}>
                  Gmail sync: {g.label}
                </span>
                <span className="badge" style={{ fontSize: 11, color: c.stale ? "#8a0000" : "rgba(18,18,18,.5)", borderColor: c.stale ? "rgba(200,0,0,.25)" : undefined }}>
                  Calendar sync: {c.label}
                </span>
              </div>
            );
          })()}
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

      {lateNudge && (
        <div className="card cardPad" style={{ borderColor: "rgba(200,100,0,.3)", background: "rgba(200,100,0,.05)" }}>
          <div style={{ fontWeight: 900, color: "rgba(140,60,0,.9)", fontSize: 14 }}>
            End-of-day push — {rules.totalRecs - todayCount} touch{rules.totalRecs - todayCount !== 1 ? "es" : ""} left to hit your goal
          </div>
          <div style={{ fontSize: 12, color: "rgba(140,60,0,.7)", marginTop: 4 }}>
            You've done {todayCount} of {rules.totalRecs} today. The contacts below are ready — don't let the day slip.
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

          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn"
              style={{ fontSize: 12 }}
              onClick={() => { setBulkOpen((v) => !v); setBulkMsg(null); }}
            >
              {bulkOpen ? "Cancel bulk" : "Log all"}
            </button>
            <a href="/insights" className="btn" style={{ textDecoration: "none", fontSize: 12 }}>
              Full report →
            </a>
          </div>
        </div>
      </div>

      {bulkOpen && (
        <div className="card cardPad stack" style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 900, fontSize: 14 }}>Log a touch for all {displayRecs.length} contacts</div>
          <div className="subtle" style={{ fontSize: 12, marginTop: -4 }}>
            Same channel + intent logged to every contact in today's list. Use for events, open houses, or mass check-ins.
          </div>
          {bulkMsg && <div className="alert alertOk">{bulkMsg}</div>}
          <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
            <div className="field">
              <div className="label">Channel</div>
              <select className="select" value={bulkChannel} onChange={(e) => setBulkChannel(e.target.value as Touch["channel"])}>
                <option value="email">Email</option>
                <option value="text">Text</option>
                <option value="call">Call</option>
                <option value="in_person">In person</option>
                <option value="social_dm">Social DM</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="field">
              <div className="label">Intent</div>
              <select className="select" value={bulkIntent} onChange={(e) => setBulkIntent(e.target.value as TouchIntent)}>
                <option value="check_in">Check-in</option>
                <option value="follow_up">Follow-up</option>
                <option value="referral_ask">Referral ask</option>
                <option value="review_ask">Review ask</option>
                <option value="event_invite">Event invite</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          <div className="field">
            <div className="label">Notes (optional)</div>
            <input className="input" value={bulkSummary} onChange={(e) => setBulkSummary(e.target.value)} placeholder="e.g. Met at open house on 123 Main" />
          </div>
          <div className="row">
            <button className="btn btnPrimary" onClick={saveBulkTouch} disabled={bulkSaving}>
              {bulkSaving ? "Logging…" : `Log ${displayRecs.length} touches`}
            </button>
            <button className="btn" onClick={() => setBulkOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* ── Follow-up reminders ── */}
      {followUps.length > 0 && (
        <div className="section" style={{ marginTop: 12 }}>
          <div className="sectionTitleRow">
            <div className="sectionTitle">Follow-ups due</div>
            <div className="sectionSub">{followUps.length} reminder{followUps.length !== 1 ? "s" : ""} waiting</div>
          </div>
          <div className="stack">
            {followUps.map((f) => {
              const name = f.contacts?.display_name ?? "Unknown";
              const contactId = f.contacts?.id ?? f.contact_id;
              const overdue = f.due_date < new Date().toISOString().slice(0, 10);
              return (
                <div key={f.id} className="card cardPad" style={{ borderColor: overdue ? "rgba(200,0,0,.2)" : "rgba(11,107,42,.2)", background: overdue ? "rgba(200,0,0,.03)" : "rgba(11,107,42,.03)" }}>
                  <div className="rowBetween" style={{ alignItems: "flex-start", gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 8, alignItems: "center" }}>
                        <span style={{ fontWeight: 900, fontSize: 15 }}>{name}</span>
                        <span className="badge" style={{ fontSize: 11, ...(overdue ? { color: "#8a0000", borderColor: "rgba(200,0,0,.25)" } : { color: "#0b6b2a", borderColor: "rgba(11,107,42,.25)" }) }}>
                          {overdue ? `Overdue · due ${f.due_date}` : `Due ${f.due_date}`}
                        </span>
                      </div>
                      {f.note && <div className="subtle" style={{ fontSize: 13, marginTop: 4 }}>{f.note}</div>}
                      {f.contacts && (
                        <div className="subtle" style={{ fontSize: 12, marginTop: 2 }}>
                          {f.contacts.category}{f.contacts.tier ? ` · Tier ${f.contacts.tier}` : ""}
                        </div>
                      )}
                    </div>
                    <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                      <a className="btn" href={`/contacts/${contactId}`} style={{ fontSize: 12, textDecoration: "none" }}>Open</a>
                      <button
                        className="btn btnPrimary"
                        style={{ fontSize: 12 }}
                        onClick={() => completeFollowUp(f.id)}
                        disabled={completingFollowUp === f.id}
                      >
                        {completingFollowUp === f.id ? "…" : "Done ✓"}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
                <div
                  className="row"
                  style={{ justifyContent: "space-between", alignItems: "flex-start" }}
                >
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
                      {c.active_deals > 0 && (
                        <span className="badge" style={{ borderColor: "rgba(11,107,42,.3)", background: "rgba(11,107,42,.07)", color: "#0b6b2a", fontWeight: 700 }}>
                          {c.active_deals} active deal{c.active_deals !== 1 ? "s" : ""}
                        </span>
                      )}
                    </div>

                    <div style={{ marginTop: 10 }} className="cardSoft cardPad">
                      <div className="rowBetween" style={{ marginBottom: 8 }}>
                        <div className="small muted bold">
                          {aiDrafts[c.id] ? "Draft (Jordan AI)" : draftsGenerating.has(c.id) ? "Generating draft…" : "Draft (template)"}
                        </div>
                        <button
                          className="btn"
                          style={{ fontSize: 11, padding: "1px 8px" }}
                          disabled={draftsGenerating.has(c.id)}
                          onClick={() => regenerateDraft(c)}
                        >
                          {draftsGenerating.has(c.id) ? "…" : "Regenerate"}
                        </button>
                      </div>

                      <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                        <span className="badge">Channel: {c.suggested_channel}</span>
                        {(["check_in", "referral_ask", "follow_up", "review_ask"] as TouchIntent[]).map((intent) => {
                          const active = (draftIntents[c.id] ?? "check_in") === intent;
                          return (
                            <button
                              key={intent}
                              className="btn"
                              style={{
                                fontSize: 11,
                                padding: "1px 8px",
                                fontWeight: active ? 900 : 400,
                                background: active ? "var(--ink)" : undefined,
                                color: active ? "var(--paper)" : undefined,
                              }}
                              onClick={() => {
                                setDraftIntents((prev) => ({ ...prev, [c.id]: intent }));
                                regenerateDraft(c, intent);
                              }}
                              disabled={draftsGenerating.has(c.id)}
                            >
                              {intent.replace("_", " ")}
                            </button>
                          );
                        })}
                      </div>

                      <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.45, opacity: draftsGenerating.has(c.id) ? 0.4 : 1 }}>
                        {aiDrafts[c.id] ?? buildDraftWithVoice({ contact: c, intent: draftIntents[c.id] ?? "check_in", channel: c.suggested_channel, voice })}
                      </div>
                    </div>
                  </div>

                  <div style={{ width: 280, display: "grid", gap: 10 }}>
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

                    {/* Remind me */}
                    <div style={{ marginTop: 10 }}>
                      <button
                        className="btn"
                        style={{ fontSize: 12 }}
                        onClick={() => { setRemindOpen((v) => !v); setRemindDate(""); setRemindNote(""); }}
                      >
                        {remindOpen ? "Cancel reminder" : "+ Set follow-up reminder"}
                      </button>
                      {remindOpen && (
                        <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
                          <div className="field">
                            <div className="label">Follow up on</div>
                            <input className="input" type="date" value={remindDate} onChange={(e) => setRemindDate(e.target.value)} />
                          </div>
                          <div className="field" style={{ flex: 1, minWidth: 180 }}>
                            <div className="label">Context (optional)</div>
                            <input className="input" value={remindNote} onChange={(e) => setRemindNote(e.target.value)} placeholder="e.g. Check if they made a decision on the listing" />
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
                      <div className="muted small">Outbound touches reset cadence.</div>
                      <div className="row">
                        <button
                          className="btn"
                          onClick={() => { setLoggingFor(null); setRemindOpen(false); }}
                          disabled={savingTouch}
                        >
                          Cancel
                        </button>
                        <button
                          className="btn btnPrimary"
                          onClick={async () => {
                            const contactId = loggingFor;
                            await saveTouch();
                            if (remindOpen && remindDate && contactId) {
                              await saveReminder(contactId);
                            }
                          }}
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