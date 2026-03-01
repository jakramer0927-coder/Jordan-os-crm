export type Channel = "email" | "text" | "call" | "in_person" | "social_dm" | "other";

export type TouchIntent =
  | "check_in"
  | "referral_ask"
  | "review_ask"
  | "deal_followup"
  | "collaboration"
  | "event_invite"
  | "other";

export type VoiceExample = {
  id?: string;
  user_id?: string;
  channel: Channel;
  contact_category: string | null;
  intent: TouchIntent | null;
  text: string;
  created_at?: string;
};

type BuildDraftArgs = {
  channel: Channel;
  intent: TouchIntent;
  contactName: string;
  contactCategory: string;
  tier?: string | null;
  clientType?: string | null;
  daysSinceOutbound?: number | null;
  examples: VoiceExample[];
};

function firstName(full: string) {
  return (full || "").trim().split(/\s+/)[0] || "";
}

function norm(s: string) {
  return (s || "").trim();
}

function lc(s: string) {
  return (s || "").toLowerCase();
}

function looksLikeSalesyFluff(s: string) {
  const x = lc(s);
  return (
    x.includes("hope you are well") ||
    x.includes("hope you’re well") ||
    x.includes("just checking in") ||
    x.includes("touching base") ||
    x.includes("per my last email")
  );
}

function splitSentences(text: string) {
  return norm(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickShortestNonFluff(examples: VoiceExample[], maxLen = 240): string[] {
  return examples
    .map((e) => norm(e.text))
    .filter((t) => t.length >= 20 && t.length <= maxLen)
    .filter((t) => !looksLikeSalesyFluff(t))
    .sort((a, b) => a.length - b.length)
    .slice(0, 25);
}

function extractOpeners(examples: VoiceExample[]) {
  // Try to infer your opener patterns from short examples:
  // e.g. "Quick one —", "X — quick check-in.", "Hey X —"
  const shorts = pickShortestNonFluff(examples, 220);
  const openers: string[] = [];

  for (const t of shorts) {
    const sents = splitSentences(t);
    if (sents.length === 0) continue;

    const first = sents[0];
    // If the first sentence is short-ish, treat as opener candidate
    if (first.length <= 60) openers.push(first);
    // Or if it includes an em dash early
    const dashIdx = first.indexOf("—");
    if (dashIdx > 0 && dashIdx < 30) openers.push(first.slice(0, dashIdx + 1).trim());
  }

  // Dedup while preserving order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of openers) {
    const key = lc(o);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o);
  }
  return out.slice(0, 10);
}

function extractClosers(examples: VoiceExample[]) {
  // Try to infer a closer style: "Worth a quick call?" / "What do you think?"
  const shorts = pickShortestNonFluff(examples, 260);
  const closers: string[] = [];
  for (const t of shorts) {
    const sents = splitSentences(t);
    if (sents.length === 0) continue;

    const last = sents[sents.length - 1];
    if (last.endsWith("?") && last.length <= 70) closers.push(last);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of closers) {
    const key = lc(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.slice(0, 10);
}

function choose<T>(arr: T[], fallback: T): T {
  if (!arr || arr.length === 0) return fallback;
  return arr[Math.floor(Math.random() * arr.length)];
}

function categoryKey(category: string) {
  const c = lc(category);
  if (c.includes("agent")) return "agent";
  if (c.includes("client")) return "client";
  if (c.includes("developer")) return "developer";
  if (c.includes("vendor")) return "vendor";
  return "other";
}

export function buildDraft(args: BuildDraftArgs): string {
  const fn = firstName(args.contactName);
  const cat = categoryKey(args.contactCategory);
  const days = args.daysSinceOutbound ?? null;

  const openers = extractOpeners(args.examples);
  const closers = extractClosers(args.examples);

  // Jordan-style defaults (tight, direct, no fluff)
  const defaultOpener =
    cat === "agent"
      ? `Quick one ${fn} —`
      : cat === "client"
      ? `${fn} — quick check-in.`
      : `Quick note ${fn} —`;

  const openerFromExamples = choose(openers, defaultOpener);

  const defaultCloser =
    cat === "agent"
      ? "Worth a quick call this week?"
      : cat === "client"
      ? "Anything you need from me right now?"
      : "Want to connect this week?";

  const closerFromExamples = choose(closers, defaultCloser);

  // A little contextualization without being robotic
  const recency =
    days == null
      ? ""
      : days >= 60
      ? "It’s been a minute since we last connected."
      : days >= 30
      ? "Been meaning to reach out."
      : "";

  // Channel tweak: texts should be shorter
  const isTexty = args.channel === "text" || args.channel === "social_dm";
  const join = (parts: string[]) => {
    const text = parts.filter(Boolean).join(" ");
    if (!isTexty) return text;
    // Tighten for text
    return text.replace(/\s+/g, " ").trim();
  };

  // Intent variants (you can expand later)
  const intent = args.intent;

  if (cat === "agent") {
    if (intent === "collaboration") {
      return join([
        openerFromExamples,
        recency,
        "I’m seeing real buyers back in motion and I’m trading notes with a few people I trust.",
        "If you’re open, I’d love to compare what you’re seeing and see where we can help each other.",
        closerFromExamples,
      ]);
    }

    return join([
      openerFromExamples,
      recency,
      "I’ve got active buyers right now and I’m staying close to anything quiet/off-market.",
      "If you have something coming up, even early, I’d love to hear about it.",
      closerFromExamples,
    ]);
  }

  if (cat === "developer") {
    return join([
      openerFromExamples,
      recency,
      "Curious what you’re seeing right now on pricing + buyer demand.",
      "Anything upcoming that’s a fit for the moment?",
      closerFromExamples,
    ]);
  }

  if (cat === "vendor") {
    return join([
      openerFromExamples,
      recency,
      "Quick check-in — how busy are you right now, and what’s your lead time looking like?",
      "I’ve got a couple things coming up and want to plan cleanly.",
      closerFromExamples,
    ]);
  }

  // Client default
  if (intent === "review_ask") {
    return join([
      openerFromExamples,
      recency,
      "Quick favor — if you have 30 seconds, would you be open to leaving a short review about working together?",
      "It helps a lot, and I’d really appreciate it.",
      closerFromExamples,
    ]);
  }

  if (intent === "referral_ask") {
    return join([
      openerFromExamples,
      recency,
      "Quick question — do you know anyone thinking about buying or selling this year?",
      "Happy to help, even if it’s just advice.",
      closerFromExamples,
    ]);
  }

  return join([
    openerFromExamples,
    recency,
    "How’s everything going on your end?",
    "Anything real-estate related on your mind right now?",
    closerFromExamples,
  ]);
}