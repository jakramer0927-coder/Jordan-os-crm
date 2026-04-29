"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  last_outbound_summary: string | null;
  days_since_outbound: number | null;
  last_inbound_at: string | null;
  active_deals: number;
  referral_gci: number;
  gmail_reply_rate: number | null;
  text_reply_rate: number | null;
  linkedin_connected_at: string | null;
  birthday: string | null;
  close_anniversary: string | null;
  move_in_date: string | null;
  closed_deal_dates: { address: string; close_date: string }[];
};

type PipelineDeal = {
  id: string;
  address: string;
  status: string;
  opp_type: string;
  buyer_stage: string | null;
  seller_stage: string | null;
  pipeline_status: string;
  price: number | null;
  close_date: string | null;
  target_list_date: string | null;
  created_at: string;
  contact_id: string;
  contacts: { id: string; display_name: string } | null;
};

type ActivePipelineAlert = {
  deal: PipelineDeal;
  reason: string;
  urgent: boolean;
};

type FollowUp = {
  id: string;
  contact_id: string;
  due_date: string;
  note: string | null;
  contacts: { id: string; display_name: string; category: string; tier: string | null } | null;
};

type ReferralFollowUp = {
  id: string;
  contact_id: string;
  contact_name: string;
  asked_on: string;
  days_ago: number;
  channel: string;
  summary: string | null;
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

function dealAnniversaries(c: ContactWithLastOutbound): { address: string; years: number; daysAway: number }[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const results: { address: string; years: number; daysAway: number }[] = [];
  for (const { address, close_date } of c.closed_deal_dates ?? []) {
    if (!close_date) continue;
    const d = new Date(close_date);
    const yearsElapsed = today.getFullYear() - d.getFullYear();
    // Check this year's anniversary and next year's if needed
    for (const yr of [yearsElapsed, yearsElapsed + 1]) {
      if (yr <= 0) continue;
      const ann = new Date(d.getFullYear() + yr, d.getMonth(), d.getDate());
      const days = Math.ceil((ann.getTime() - today.getTime()) / 86400000);
      if (days >= 0 && days <= 30) {
        results.push({ address, years: yr, daysAway: days });
        break;
      }
    }
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

function topTrigger(c: Recommendation): { text: string; color: string } {
  const anns = dealAnniversaries(c);
  if (anns.length > 0) {
    const a = anns[0];
    const when = a.daysAway === 0 ? "today" : `in ${a.daysAway}d`;
    return { text: `${a.years}-year anniversary of ${a.address} ${when}`, color: "#1a3f8a" };
  }
  const ms = upcomingMilestones(c);
  if (ms.length > 0) {
    const m = ms[0];
    return { text: m.daysAway === 0 ? `${m.label} is today` : `${m.label} in ${m.daysAway}d`, color: "#1a3f8a" };
  }
  if (c.active_deals > 0) return { text: `${c.active_deals} active deal${c.active_deals !== 1 ? "s" : ""} in pipeline`, color: "#0b6b2a" };
  if (c.days_since_outbound == null) return { text: "No outbound yet — first touch opportunity", color: "#92610a" };
  if (c.overdue) return { text: `${c.days_since_outbound}d since last touch · cadence is ${c.cadence}d`, color: "#8a0000" };
  return { text: `${c.days_since_outbound}d since last touch`, color: "rgba(18,18,18,.5)" };
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
    if (t === "D") return 150;
    return 60;
  }
  if (cat === "agent") {
    if (t === "A") return 30;
    if (t === "D") return 150;
    return 60;
  }
  if (cat === "developer") return 60;
  if (cat === "vendor") return 60;
  if (cat === "sphere") {
    if (t === "A") return 30;
    if (t === "B") return 60;
    if (t === "D") return 150;
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


function preferredChannel(c: Recommendation): string | null {
  const g = c.gmail_reply_rate ?? 0;
  const t = c.text_reply_rate ?? 0;
  if (g >= 60 && g > t + 20) return "email";
  if (t >= 60 && t > g + 20) return "text";
  return null;
}

function contextTalkingPoint(c: Recommendation): string {
  const cat = (c.category || "").toLowerCase();
  const t = (c.tier || "").toUpperCase();
  const anns = dealAnniversaries(c);
  const ms = upcomingMilestones(c);
  const channel = preferredChannel(c);

  if (anns.length > 0) {
    const a = anns[0];
    return `Acknowledge the ${a.years}-year anniversary${a.daysAway === 0 ? " — reach out today" : ` in ${a.daysAway}d`} — ask how they're enjoying the home.`;
  }
  if (ms.some(m => m.label === "Birthday")) {
    return "Simple birthday message — no real estate, just a warm personal touch.";
  }
  if (c.active_deals > 0) {
    return cat === "client"
      ? "Active deal in progress — market update and timeline check-in."
      : "Active deal moving — check on status and any co-op opportunities.";
  }
  if (c.referral_gci > 0) {
    return `Referral source with $${(c.referral_gci / 1000).toFixed(0)}k in past GCI — thank them and ask who in their world might need help next.`;
  }
  if (cat === "agent") {
    return t === "A"
      ? "Ask what they're seeing on listings and buyer demand — position yourself for a co-op."
      : "Quick market pulse check — stay top of mind for future co-ops and referrals.";
  }
  if (cat === "developer") {
    return "Ask about absorption, buyer feedback, and what's coming up — offer comp analysis if useful.";
  }
  if (cat === "sphere" && (c.days_since_outbound ?? 999) > 90) {
    return "Long overdue — genuine personal check-in, no agenda. Just reconnect.";
  }
  if (cat === "client" && t === "A") {
    const channelNote = channel ? ` Prefers ${channel}.` : "";
    return `A-Client — personal check-in with a value-add offer: market update, vendor referral, or equity snapshot.${channelNote}`;
  }
  if (cat === "client") {
    return "Past client check-in — ask how they're enjoying the home and if anything real estate is on their mind.";
  }
  if (c.days_since_outbound == null) {
    return "First touch — introduce yourself genuinely and find common ground before any ask.";
  }
  return "Check in genuinely — ask about them first, real estate second.";
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

function todayIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function loadLockedIds(uid: string): Promise<string[] | null> {
  const { data } = await supabase
    .from("morning_locks")
    .select("contact_ids")
    .eq("user_id", uid)
    .eq("lock_date", todayIsoDate())
    .maybeSingle();
  return (data?.contact_ids as string[] | null) ?? null;
}

async function saveLockedIds(uid: string, ids: string[]) {
  await supabase.from("morning_locks").upsert(
    { user_id: uid, lock_date: todayIsoDate(), contact_ids: ids, updated_at: new Date().toISOString() },
    { onConflict: "user_id,lock_date" }
  );
}

async function clearLockedIds(uid: string) {
  await supabase.from("morning_locks").delete().eq("user_id", uid).eq("lock_date", todayIsoDate());
}

const rulesLsKey = (uid: string) => `morning_rules_v2_${uid}`;

async function loadRules(uid: string): Promise<MorningRules> {
  try {
    const { data } = await supabase
      .from("user_settings")
      .select("value")
      .eq("user_id", uid)
      .eq("key", "morning_rules")
      .maybeSingle();
    if (data?.value) {
      const rules = { ...DEFAULT_RULES, ...(data.value as Partial<MorningRules>) };
      try { localStorage.setItem(rulesLsKey(uid), JSON.stringify(rules)); } catch {}
      return rules;
    }
  } catch {}
  // Fallback: localStorage cache
  try {
    const raw = localStorage.getItem(rulesLsKey(uid));
    if (raw) return { ...DEFAULT_RULES, ...JSON.parse(raw) };
  } catch {}
  return DEFAULT_RULES;
}

async function saveRules(uid: string, r: MorningRules) {
  // Write to localStorage immediately — guarantees same-device persistence even if Supabase is slow
  try { localStorage.setItem(rulesLsKey(uid), JSON.stringify(r)); } catch {}
  // Write to Supabase for cross-device sync
  await supabase.from("user_settings").upsert(
    { user_id: uid, key: "morning_rules", value: r, updated_at: new Date().toISOString() },
    { onConflict: "user_id,key" }
  );
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
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);

  // logging touch inline
  const [loggingFor, setLoggingFor] = useState<string | null>(null);
  const [touchChannel, setTouchChannel] = useState<Touch["channel"]>("text");
  const [touchIntent, setTouchIntent] = useState<TouchIntent>("check_in");
  const [touchSummary, setTouchSummary] = useState("");
  const [touchSource, setTouchSource] = useState("manual");
  const [touchLink, setTouchLink] = useState("");
  const [savingTouch, setSavingTouch] = useState(false);

  // stable list + completed tracking — persisted per calendar day (loaded after uid is known)
  const [lockedIds, setLockedIds] = useState<string[] | null>(null);
  const [lockedIdsLoaded, setLockedIdsLoaded] = useState(false);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());


  // Pipeline momentum alerts
  const [staleDealAlerts, setStaleDealAlerts] = useState<PipelineDeal[]>([]);
  const [activePipelineAlerts, setActivePipelineAlerts] = useState<ActivePipelineAlert[]>([]);

  // Follow-ups
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [completingFollowUp, setCompletingFollowUp] = useState<string | null>(null);
  // Referral ask follow-ups (touches logged as referral_ask 25-40 days ago with no outcome)
  const [referralFollowUps, setReferralFollowUps] = useState<ReferralFollowUp[]>([]);
  const [savingFollowUp, setSavingFollowUp] = useState<string | null>(null);
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

  // prevents rulesReady effect from clearing the Supabase lock when rules load on init
  const rulesSetFromInit = useRef(false);

  // mobile
  const [isMobile, setIsMobile] = useState(false);
  const [mobileLogContact, setMobileLogContact] = useState<Recommendation | null>(null);
  const swipeTouchStartX = useRef(0);
  const swipeTouchStartY = useRef(0);

  // accountability strip
  const [todayCount, setTodayCount] = useState(0);
  const [wtdCount, setWtdCount] = useState(0);

  // sync health
  const [syncGmail, setSyncGmail] = useState<string | null>(null);
  const [syncCalendar, setSyncCalendar] = useState<string | null>(null);

  // operating rules — loaded after uid is known (in init effect)
  const [rules, setRules] = useState<MorningRules>(DEFAULT_RULES);
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

  async function load(forceRefresh = false) {
    setError(null);
    setMsg(null);
    setLoading(true);
    // Only clear the lock on a manual refresh — not on initial page load
    const user = await requireSession();
    if (!user) { setLoading(false); return; }

    if (forceRefresh) {
      setLockedIds(null);
      await clearLockedIds(user.id);
    }

    // Fetch contacts+touches+counts, voice profile, sync status, follow-ups, and pipeline in parallel
    const [contactsRes, syncRes, followUpsRes, pipelineRes] = await Promise.all([
      fetch("/api/morning/contacts"),
      fetch("/api/sync/status"),
      fetch("/api/follow-ups?due_today=1"),
      fetch("/api/pipeline"),
      voiceLoaded ? Promise.resolve() : loadVoiceProfile(user.id),
      loadReferralFollowUps(),
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

    // Pre-populate completedIds from contacts touched today so ✓ survives navigation
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const touchedToday = new Set(
      ((merged ?? []) as ContactWithLastOutbound[])
        .filter(c => c.last_outbound_at && new Date(c.last_outbound_at) >= todayStart)
        .map(c => c.id)
    );
    if (touchedToday.size > 0) setCompletedIds(prev => new Set([...prev, ...touchedToday]));

    if (pipelineRes.ok) {
      const pj = await pipelineRes.json().catch(() => ({}));
      const allDeals: PipelineDeal[] = pj.deals ?? [];
      const now = Date.now();

      // Stale deal momentum alerts (legacy status-based)
      const stale = allDeals.filter(d => {
        const days = Math.floor((now - new Date(d.created_at).getTime()) / 86400000);
        const thresholds: Record<string, number> = { lead: 60, showing: 30, offer_in: 14, under_contract: 60 };
        const threshold = thresholds[d.status] ?? 999;
        const closeOverdue = d.close_date && new Date(d.close_date) < new Date() && d.status === "under_contract";
        return closeOverdue || days >= threshold;
      });
      stale.sort((a, b) => {
        const aOverdue = a.close_date && new Date(a.close_date) < new Date() ? 1 : 0;
        const bOverdue = b.close_date && new Date(b.close_date) < new Date() ? 1 : 0;
        if (bOverdue !== aOverdue) return bOverdue - aOverdue;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });
      setStaleDealAlerts(stale);

      // Active pipeline touch alerts — buyers/sellers untouched 7+ days, or seller near target_list_date
      const contactDaysSince: Record<string, number | null> = {};
      for (const c of (merged ?? []) as ContactWithLastOutbound[]) {
        contactDaysSince[c.id] = c.days_since_outbound ?? null;
      }

      const pipelineAlerts: ActivePipelineAlert[] = [];
      const seen = new Set<string>();

      for (const deal of allDeals) {
        if (!["buyer", "seller"].includes(deal.opp_type)) continue;
        if (deal.pipeline_status !== "active") continue;
        if (seen.has(deal.contact_id)) continue;

        // Seller near target_list_date — always surface if within 30 days
        if (deal.opp_type === "seller" && deal.target_list_date) {
          const daysToList = Math.ceil((new Date(deal.target_list_date).getTime() - now) / 86400000);
          if (daysToList >= 0 && daysToList <= 30) {
            const label = daysToList === 0 ? "Target list date is today" : `Target list date in ${daysToList}d`;
            pipelineAlerts.push({ deal, reason: label, urgent: daysToList <= 7 });
            seen.add(deal.contact_id);
            continue;
          }
        }

        // Untouched 7+ days
        const d = contactDaysSince[deal.contact_id];
        const untouched = d == null || d >= 7;
        if (untouched) {
          const typeLabel = deal.opp_type === "buyer" ? "Active buyer" : "Active seller";
          const touchLabel = d == null ? "never touched" : `${d}d since last touch`;
          pipelineAlerts.push({ deal, reason: `${typeLabel} — ${touchLabel}`, urgent: d == null || d >= 14 });
          seen.add(deal.contact_id);
        }
      }

      setActivePipelineAlerts(pipelineAlerts);
    }

    setLoading(false);
  }

  function openLog(c: Recommendation) {
    setLoggingFor(c.id);
    setTouchChannel(c.suggested_channel);
    setTouchIntent("check_in");
    setTouchSummary("");
    setTouchSource("manual");
    setTouchLink("");
    if (isMobile) setMobileLogContact(c);
  }

  function closeMobileSheet() {
    setMobileLogContact(null);
    setLoggingFor(null);
    setTouchSummary("");
    setRemindOpen(false);
  }

  const handleCardTouchStart = useCallback((e: React.TouchEvent) => {
    swipeTouchStartX.current = e.touches[0].clientX;
    swipeTouchStartY.current = e.touches[0].clientY;
  }, []);

  function handleCardTouchEnd(e: React.TouchEvent, c: Recommendation) {
    const dx = e.changedTouches[0].clientX - swipeTouchStartX.current;
    const dy = e.changedTouches[0].clientY - swipeTouchStartY.current;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) openLog(c); // left swipe → log
    }
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
      // Auto-set outcome=pending for referral asks so we can follow up in 30 days
      outcome: touchIntent === "referral_ask" ? "pending" : null,
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

  async function loadReferralFollowUps() {
    const twentyFiveDaysAgo = new Date(Date.now() - 25 * 86400000).toISOString();
    const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();
    const { data } = await supabase
      .from("touches")
      .select("id, contact_id, occurred_at, channel, summary, contacts!inner(display_name)")
      .eq("intent", "referral_ask")
      .eq("outcome", "pending")
      .eq("direction", "outbound")
      .lte("occurred_at", twentyFiveDaysAgo)
      .gte("occurred_at", fortyDaysAgo);
    if (!data) return;
    const now = Date.now();
    setReferralFollowUps(
      (data as any[]).map((row) => ({
        id: row.id,
        contact_id: row.contact_id,
        contact_name: (row.contacts as any)?.display_name ?? "Unknown",
        asked_on: row.occurred_at,
        days_ago: Math.floor((now - new Date(row.occurred_at).getTime()) / 86400000),
        channel: row.channel,
        summary: row.summary,
      }))
    );
  }

  async function recordReferralOutcome(touchId: string, outcome: "referred" | "no_referral") {
    setSavingFollowUp(touchId);
    const { error } = await supabase.from("touches").update({ outcome }).eq("id", touchId);
    setSavingFollowUp(null);
    if (!error) setReferralFollowUps((prev) => prev.filter((f) => f.id !== touchId));
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

      // Load persisted settings + today's lock from Supabase (cross-device)
      const [savedRules, savedLock] = await Promise.all([
        loadRules(user.id),
        loadLockedIds(user.id),
      ]);
      if (!alive) return;
      rulesSetFromInit.current = true; // prevent rulesReady effect from clearing the loaded lock
      setRules(savedRules);
      setLockedIds(savedLock);
      setLockedIdsLoaded(true);

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

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
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

      // Deal anniversaries within 30 days get a strong boost
      const anns = dealAnniversaries(c);
      if (anns.length > 0) {
        const a = anns[0];
        const when = a.daysAway === 0 ? "today" : `in ${a.daysAway}d`;
        reasons.push(`${a.years}-year anniversary of ${a.address} ${when}`);
      }

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

      // Referral attribution: past referral GCI is a strong signal this contact is worth nurturing
      // $100k in referral GCI → +15, capped at +60
      if (c.referral_gci > 0) {
        score += Math.min(60, Math.floor(c.referral_gci / 100000) * 15);
        reasons.push(`Referral source — $${(c.referral_gci / 1000).toFixed(0)}k in closed GCI`);
      }

      // Engagement signal: high reply rate = this person actually responds, worth prioritizing
      const bestReplyRate = Math.max(c.gmail_reply_rate ?? 0, c.text_reply_rate ?? 0);
      if (bestReplyRate >= 60) score += 10;
      else if (bestReplyRate > 0 && bestReplyRate <= 20) score -= 5; // consistently unresponsive

      // LinkedIn connection: verified professional relationship
      if (c.linkedin_connected_at) score += 5;

      // Anniversary boost — strong reason to reach out even if recently touched
      if (anns.length > 0) {
        const daysAway = anns[0].daysAway;
        score += daysAway <= 7 ? 80 : daysAway <= 14 ? 50 : 30;
      }

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

    // Fill remaining slots — only contacts at least 30% through their cadence
    // (or never contacted). Never pad with recently-touched people.
    // D-tier contacts fill last — only after all A/B/C/untiered slots are exhausted.
    // Category diversity cap: max 2 per category in fill phase.
    const fillCategoryCounts: Record<string, number> = {};
    for (const c of top) {
      const cat = (c.category || "other").toLowerCase();
      fillCategoryCounts[cat] = (fillCategoryCounts[cat] ?? 0) + 1;
    }

    const isEligibleFill = (c: Recommendation) => {
      if (used.has(c.id)) return false;
      if (c.score === -999) return false; // recency-protected
      const isNeverContacted = c.days_since_outbound == null;
      const isApproachingDue = c.days_since_outbound != null && c.days_since_outbound >= c.cadence * 0.3;
      return isNeverContacted || isApproachingDue;
    };

    // Non-D-tier fill first, then D-tier — enforces hard ordering so D-tier only appears
    // when no higher-value contacts remain
    const nonDPool = scored.filter(c => isEligibleFill(c) && (c.tier || "").toUpperCase() !== "D");
    const dPool = scored.filter(c => isEligibleFill(c) && (c.tier || "").toUpperCase() === "D");

    for (const pool of [nonDPool, dPool]) {
      for (const c of pool) {
        if (top.length >= totalRecs) break;
        const cat = (c.category || "other").toLowerCase();
        if ((fillCategoryCounts[cat] ?? 0) >= 2) continue;
        top.push(c);
        used.add(c.id);
        fillCategoryCounts[cat] = (fillCategoryCounts[cat] ?? 0) + 1;
      }
      if (top.length >= totalRecs) break;
    }

    return top;
  }, [contacts, voice, rules]);

  // Reset locked list when user explicitly changes rules — skip the init load from Supabase
  useEffect(() => {
    if (!rulesReady) { setRulesReady(true); return; }
    if (rulesSetFromInit.current) { rulesSetFromInit.current = false; return; }
    setLockedIds(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules]);

  useEffect(() => {
    if (!lockedIdsLoaded) return; // wait until Supabase lock has been checked
    if (lockedIds === null && recs.length > 0) {
      const ids = recs.map((r) => r.id);
      setLockedIds(ids);
      if (uid) saveLockedIds(uid, ids); // fire-and-forget
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recs, lockedIds, lockedIdsLoaded]);

  // Stable display list — always shows the same contacts from first load today.
  // Falls back to the full contacts array for any locked contact that has since
  // been touched (score = -999) and dropped out of the top-N recs.
  const displayRecs = useMemo<Recommendation[]>(() => {
    if (lockedIds === null) return recs;
    return lockedIds
      .map((id) => {
        const fromRecs = recs.find((r) => r.id === id);
        if (fromRecs) return fromRecs;
        // Contact was touched today and fell out of recs — reconstruct from contacts
        const c = contacts.find((c) => c.id === id);
        if (!c) return null;
        return {
          ...c,
          cadence: cadenceDays(c.category, c.tier),
          overdue: false,
          score: -999,
          reasons: ["Recently contacted"],
          suggested_channel: "text" as const,
        } satisfies Recommendation;
      })
      .filter((r): r is Recommendation => r != null);
  }, [lockedIds, recs, contacts]);

  const stats = useMemo(() => {
    const total = contacts.length;
    const overdue = contacts.filter((c) => isOverdue(c)).length;
    const overdueA = contacts.filter((c) => isAClient(c) && isOverdue(c)).length;
    const agents = contacts.filter((c) => (c.category || "").toLowerCase() === "agent").length;
    const unclassified = contacts.filter((c) => !c.tier).length;
    return { total, overdue, overdueA, agents, unclassified };
  }, [contacts]);

  if (!ready) return <div className="page">Loading…</div>;

  const weekday = isWeekdayLocal();
  const showTriageBanner = stats.unclassified >= 10;
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
            {weekday ? (
              <>
                <span className="badge">{stats.total} contacts</span>{" "}
                <span className="badge">{stats.overdue} overdue</span>{" "}
                <span className="badge">{stats.overdueA} A-clients overdue</span>{" "}
                <span className="badge">{stats.agents} agents</span>
              </>
            ) : (
              <span className="badge">Weekend — pipeline view only</span>
            )}
          </div>

          {weekday && (
            <div style={{ marginTop: 8 }}>
              <button
                style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 700, color: "rgba(18,18,18,.4)", padding: 0 }}
                onClick={() => setVoiceSettingsOpen(v => !v)}
              >
                Voice settings {voiceSettingsOpen ? "▲" : "▾"}
              </button>
              {voiceSettingsOpen && (
                <div className="muted small" style={{ marginTop: 6 }}>
                  {voiceLoaded
                    ? <>
                        <strong>{voice?.count ?? 0}</strong> examples loaded
                        {voice?.rules?.length ? <> · <strong>Rules:</strong> {voice.rules.slice(0, 3).join(" • ")}</> : null}
                      </>
                    : "Loading…"
                  }
                </div>
              )}
            </div>
          )}

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
          <a className="btn" href="/pipeline">
            Pipeline
          </a>
          <a className="btn" href="/unmatched">
            Unmatched
          </a>
          <button className="btn" onClick={() => load(true)} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {showTriageBanner && (
        <div className="card cardPad" style={{ borderColor: "rgba(180,120,0,0.3)", background: "rgba(255,180,0,0.06)", marginBottom: 8 }}>
          <div className="rowBetween" style={{ alignItems: "center" }}>
            <div>
              <span style={{ fontWeight: 800 }}>{stats.unclassified} contacts</span>
              <span className="muted"> need a tier — your Morning coaching won't be accurate until they're classified.</span>
            </div>
            <a className="btn btnPrimary" href="/triage" style={{ flexShrink: 0, marginLeft: 12 }}>
              Classify now →
            </a>
          </div>
        </div>
      )}

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
                      if (uid) saveRules(uid, next);
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

      {/* ── Referral ask follow-ups ── */}
      {referralFollowUps.length > 0 && (
        <div className="section" style={{ marginTop: 12 }}>
          <div className="sectionTitleRow">
            <div className="sectionTitle">Referral asks — close the loop</div>
            <div className="sectionSub">{referralFollowUps.length} ask{referralFollowUps.length !== 1 ? "s" : ""} from ~30 days ago</div>
          </div>
          <div className="stack">
            {referralFollowUps.map((f) => (
              <div key={f.id} className="card cardPad" style={{ borderColor: "rgba(180,120,0,.2)", background: "rgba(255,200,0,.03)" }}>
                <div className="rowBetween" style={{ alignItems: "flex-start", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 8, alignItems: "center" }}>
                      <a href={`/contacts/${f.contact_id}`} style={{ fontWeight: 900, fontSize: 15, textDecoration: "none", color: "var(--ink)" }}>
                        {f.contact_name}
                      </a>
                      <span className="badge" style={{ fontSize: 11, color: "rgba(140,90,0,.9)", borderColor: "rgba(180,120,0,.3)" }}>
                        Asked {f.days_ago}d ago via {f.channel}
                      </span>
                    </div>
                    {f.summary && (
                      <div className="subtle" style={{ fontSize: 12, marginTop: 4 }}>
                        "{f.summary.length > 100 ? `${f.summary.slice(0, 100)}…` : f.summary}"
                      </div>
                    )}
                  </div>
                  <div className="row" style={{ gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                    <button
                      className="btn btnPrimary"
                      style={{ fontSize: 12, background: "#0b6b2a", borderColor: "#0b6b2a" }}
                      onClick={() => recordReferralOutcome(f.id, "referred")}
                      disabled={savingFollowUp === f.id}
                    >
                      {savingFollowUp === f.id ? "…" : "Got a referral ✓"}
                    </button>
                    <button
                      className="btn"
                      style={{ fontSize: 12 }}
                      onClick={() => recordReferralOutcome(f.id, "no_referral")}
                      disabled={savingFollowUp === f.id}
                    >
                      No outcome
                    </button>
                  </div>
                </div>
              </div>
            ))}
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

      {/* ── Pipeline momentum alerts ── */}
      {staleDealAlerts.length > 0 && (
        <div className="section" style={{ marginTop: 12 }}>
          <div className="sectionTitleRow">
            <div className="sectionTitle">Pipeline needs attention</div>
            <div className="sectionSub">{staleDealAlerts.length} deal{staleDealAlerts.length !== 1 ? "s" : ""} stalled or overdue</div>
          </div>
          <div className="stack">
            {staleDealAlerts.map(deal => {
              const days = Math.floor((Date.now() - new Date(deal.created_at).getTime()) / 86400000);
              const closeOverdue = deal.close_date && new Date(deal.close_date) < new Date();
              const stageLabels: Record<string, string> = { lead: "Lead", showing: "Showing", offer_in: "Offer In", under_contract: "Under Contract" };
              return (
                <div key={deal.id} className="card cardPad" style={{ borderColor: closeOverdue ? "rgba(200,0,0,.2)" : "rgba(200,100,0,.2)", background: closeOverdue ? "rgba(200,0,0,.03)" : "rgba(200,100,0,.03)", padding: "10px 14px" }}>
                  <div className="rowBetween" style={{ alignItems: "flex-start", gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: 14 }}>{deal.address}</div>
                      <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                        {deal.contacts && (
                          <span style={{ fontSize: 12, color: "rgba(18,18,18,.6)", fontWeight: 700 }}>{deal.contacts.display_name}</span>
                        )}
                        <span className="badge" style={{ fontSize: 11 }}>{stageLabels[deal.status] ?? deal.status}</span>
                        <span style={{ fontSize: 12, fontWeight: 700, color: closeOverdue ? "#8a0000" : "#92610a" }}>
                          {closeOverdue
                            ? `⚠ Close date overdue · ${days}d in pipeline`
                            : `${days}d in stage — check status`}
                        </span>
                      </div>
                    </div>
                    <a className="btn" href="/pipeline" style={{ fontSize: 12, textDecoration: "none", flexShrink: 0 }}>View →</a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Active pipeline — check-in needed ── */}
      {activePipelineAlerts.length > 0 && (
        <div className="section" style={{ marginTop: 12 }}>
          <div className="sectionTitleRow">
            <div className="sectionTitle">Active pipeline — check-in needed</div>
            <div className="sectionSub">{activePipelineAlerts.length} buyer{activePipelineAlerts.length !== 1 ? "s/sellers" : "/seller"} without recent touch</div>
          </div>
          <div className="stack">
            {activePipelineAlerts.map(({ deal, reason, urgent }) => {
              const name = deal.contacts?.display_name ?? "Unknown";
              const stageLabel = deal.opp_type === "buyer"
                ? (deal.buyer_stage ?? "").replace(/_/g, " ")
                : (deal.seller_stage ?? "").replace(/_/g, " ");
              return (
                <div key={deal.id} className="card cardPad" style={{ borderColor: urgent ? "rgba(200,0,0,.2)" : "rgba(200,100,0,.2)", background: urgent ? "rgba(200,0,0,.03)" : "rgba(200,100,0,.03)", padding: "10px 14px" }}>
                  <div className="rowBetween" style={{ alignItems: "flex-start", gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 800, fontSize: 14 }}>{name}</div>
                      <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                        <span className="badge" style={{ fontSize: 11 }}>{deal.opp_type}</span>
                        {stageLabel && <span className="badge" style={{ fontSize: 11 }}>{stageLabel}</span>}
                        {deal.address && <span style={{ fontSize: 12, color: "rgba(18,18,18,.55)" }}>{deal.address}</span>}
                        <span style={{ fontSize: 12, fontWeight: 700, color: urgent ? "#8a0000" : "#92610a" }}>{reason}</span>
                      </div>
                    </div>
                    <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                      <a className="btn" href={`/contacts/${deal.contact_id}`} style={{ fontSize: 12, textDecoration: "none" }}>Contact</a>
                      <a className="btn" href={`/pipeline?deal=${deal.id}`} style={{ fontSize: 12, textDecoration: "none" }}>Deal →</a>
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
                onTouchStart={handleCardTouchStart}
                onTouchEnd={(e) => handleCardTouchEnd(e, c)}
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

                    {/* Trigger reason */}
                    {(() => {
                      const trigger = topTrigger(c);
                      return (
                        <div style={{ marginTop: 6, fontSize: 12, fontWeight: 700, color: trigger.color }}>
                          {trigger.text}
                        </div>
                      );
                    })()}

                    <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
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
                      {upcomingMilestones(c).map((m) => (
                        <span key={m.label} className="badge" style={{ borderColor: "rgba(26,63,138,.3)", background: "rgba(26,63,138,.06)", color: "#1a3f8a", fontWeight: 700 }}>
                          {m.daysAway === 0 ? `${m.label} today` : `${m.label} in ${m.daysAway}d`}
                        </span>
                      ))}
                      {dealAnniversaries(c).map((a) => (
                        <span key={a.address} className="badge" style={{ borderColor: "rgba(26,63,138,.3)", background: "rgba(26,63,138,.06)", color: "#1a3f8a", fontWeight: 700 }}>
                          {a.years}yr anniversary{a.daysAway === 0 ? " today" : ` in ${a.daysAway}d`}
                        </span>
                      ))}
                    </div>

                    {/* Context brief — instant, no API call */}
                    <div style={{ marginTop: 10 }} className="cardSoft cardPad">
                      <div style={{ fontSize: 11, fontWeight: 700, color: "rgba(18,18,18,.4)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                        Talking point
                      </div>
                      <div style={{ fontSize: 13, lineHeight: 1.55, color: "var(--ink)" }}>
                        {contextTalkingPoint(c)}
                      </div>
                      {c.last_outbound_summary && (
                        <div style={{ marginTop: 8, fontSize: 12, color: "rgba(18,18,18,.5)", borderTop: "1px solid rgba(0,0,0,.06)", paddingTop: 8 }}>
                          <span style={{ fontWeight: 700 }}>Last note:</span>{" "}
                          {c.last_outbound_summary.length > 120
                            ? `${c.last_outbound_summary.slice(0, 120)}…`
                            : c.last_outbound_summary}
                        </div>
                      )}
                      {(c.referral_gci > 0 || c.gmail_reply_rate !== null || c.text_reply_rate !== null || c.linkedin_connected_at) && (
                        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                          {c.referral_gci > 0 && (
                            <span className="badge" style={{ fontSize: 11, color: "#0b6b2a", borderColor: "rgba(11,107,42,.25)", background: "rgba(11,107,42,.05)" }}>
                              Referral ${(c.referral_gci / 1000).toFixed(0)}k GCI
                            </span>
                          )}
                          {c.gmail_reply_rate !== null && (
                            <span className="badge" style={{ fontSize: 11, color: c.gmail_reply_rate >= 60 ? "#0b6b2a" : c.gmail_reply_rate <= 20 ? "#8a0000" : undefined }}>
                              Email {c.gmail_reply_rate}% reply
                            </span>
                          )}
                          {c.text_reply_rate !== null && (
                            <span className="badge" style={{ fontSize: 11, color: c.text_reply_rate >= 60 ? "#0b6b2a" : c.text_reply_rate <= 20 ? "#8a0000" : undefined }}>
                              Text {c.text_reply_rate}% reply
                            </span>
                          )}
                          {c.linkedin_connected_at && (
                            <span className="badge" style={{ fontSize: 11 }}>LinkedIn</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div style={{ width: isMobile ? "100%" : 280, display: "grid", gap: 8 }}>
                    {isMobile ? (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                        <a className="btn" href={`/contacts/${c.id}`} style={{ justifyContent: "center" }}>
                          Open
                        </a>
                        <button className="btn btnPrimary" onClick={() => openLog(c)}>
                          Log touch
                        </button>
                      </div>
                    ) : (
                      <>
                        <a className="btn" href={`/contacts/${c.id}`}>
                          Open contact
                        </a>
                        <button className="btn btnPrimary" onClick={() => openLog(c)}>
                          Log outbound touch
                        </button>
                      </>
                    )}
                    {isMobile && !completed && (
                      <div className="muted" style={{ fontSize: 11, textAlign: "center", marginTop: 2 }}>
                        or swipe left to log
                      </div>
                    )}
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

      {/* ── Mobile bottom sheet for logging ── */}
      {mobileLogContact && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 200,
            background: "rgba(0,0,0,.45)",
            display: "flex", alignItems: "flex-end",
          }}
          onClick={(e) => { if (e.target === e.currentTarget) closeMobileSheet(); }}
        >
          <div style={{
            width: "100%", background: "var(--paper)",
            borderRadius: "20px 20px 0 0",
            padding: "20px 16px 40px",
            boxShadow: "0 -4px 32px rgba(0,0,0,.18)",
            animation: "slideUp .22s ease",
          }}>
            {/* Handle */}
            <div style={{ width: 40, height: 4, borderRadius: 2, background: "rgba(0,0,0,.15)", margin: "0 auto 16px" }} />

            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 17 }}>{mobileLogContact.display_name}</div>
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                  {mobileLogContact.category}{mobileLogContact.tier ? ` · Tier ${mobileLogContact.tier}` : ""}
                </div>
              </div>
              <button onClick={closeMobileSheet} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "var(--muted)", padding: "4px 8px" }}>✕</button>
            </div>

            {/* Channel pills */}
            <div style={{ marginBottom: 14 }}>
              <div className="label" style={{ marginBottom: 8 }}>Channel</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(["text", "call", "email", "in_person", "social_dm"] as Touch["channel"][]).map((ch) => (
                  <button
                    key={ch}
                    onClick={() => setTouchChannel(ch)}
                    style={{
                      padding: "8px 14px", borderRadius: 999, fontSize: 13, fontWeight: 700,
                      border: "1px solid",
                      borderColor: touchChannel === ch ? "var(--accent)" : "var(--line)",
                      background: touchChannel === ch ? "var(--accent)" : "var(--paper)",
                      color: touchChannel === ch ? "#fff" : "var(--ink)",
                      cursor: "pointer",
                    }}
                  >
                    {ch === "in_person" ? "In Person" : ch === "social_dm" ? "DM" : ch.charAt(0).toUpperCase() + ch.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Summary */}
            <div style={{ marginBottom: 16 }}>
              <div className="label" style={{ marginBottom: 6 }}>Notes (optional)</div>
              <textarea
                className="textarea"
                autoFocus
                value={touchSummary}
                onChange={(e) => setTouchSummary(e.target.value)}
                placeholder="Quick note — what you sent or what happened"
                style={{ minHeight: 72, fontSize: 16 }}
              />
            </div>

            {/* Follow-up reminder */}
            <div style={{ marginBottom: 16 }}>
              <button
                className="btn"
                style={{ fontSize: 13, width: "100%" }}
                onClick={() => { setRemindOpen(v => !v); setRemindDate(""); setRemindNote(""); }}
              >
                {remindOpen ? "Cancel reminder" : "+ Set follow-up reminder"}
              </button>
              {remindOpen && (
                <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
                  <div className="field">
                    <div className="label">Follow up on</div>
                    <input className="input" type="date" value={remindDate} onChange={(e) => setRemindDate(e.target.value)} />
                  </div>
                  <div className="field">
                    <div className="label">Context (optional)</div>
                    <input className="input" value={remindNote} onChange={(e) => setRemindNote(e.target.value)} placeholder="e.g. Check if they made a decision" />
                  </div>
                </div>
              )}
            </div>

            {/* Submit */}
            <button
              className="btn btnPrimary"
              style={{ width: "100%", fontSize: 16, padding: "14px", justifyContent: "center" }}
              disabled={savingTouch}
              onClick={async () => {
                const contactId = loggingFor;
                await saveTouch();
                if (remindOpen && remindDate && contactId) await saveReminder(contactId);
                closeMobileSheet();
              }}
            >
              {savingTouch ? "Logging…" : "Log touch"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}