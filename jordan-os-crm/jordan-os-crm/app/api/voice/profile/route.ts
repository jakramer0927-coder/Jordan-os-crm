import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function safeErr(e: unknown) {
  const anyE = e as { message?: unknown; name?: unknown; stack?: unknown };
  return {
    message: String(anyE?.message || e || "Unknown error"),
    name: String(anyE?.name || ""),
    stack: typeof anyE?.stack === "string" ? anyE.stack.split("\n").slice(0, 10).join("\n") : "",
  };
}

function normalizeWhitespace(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function firstNameFromText(s: string): string | null {
  const t = (s || "").trim();
  if (!t) return null;
  const first = t.split(/\s+/)[0] || "";
  const clean = first.replace(/[^a-zA-Z'-]/g, "");
  return clean.length >= 2 ? clean : null;
}

function extractSignals(text: string) {
  const t = text.toLowerCase();

  const signals = {
    hasQuick: /quick (note|one|check-in|check in)/i.test(text),
    hasExclamation: text.includes("!"),
    hasQuestion: text.includes("?"),
    hasEmDash: text.includes("—"),
    hasWarm:
      /(hope you|hope you're|how (are|is) (everything|it going)|checking in|just wanted to)/i.test(
        text,
      ),
    hasValue:
      /(sharing|sending|flagging|heads up|fyi|in case helpful|thought of you|wanted to pass along|looping in)/i.test(
        text,
      ),
    hasSoftClose: /(no rush|no pressure|happy to|let me know|if helpful|when you have a sec)/i.test(
      text,
    ),
    hasDirect: /(quick question|can you|are you open to|what’s your|what are you seeing)/i.test(
      text,
    ),
    hasSalesy: /(amazing opportunity|act now|don’t miss|limited time|exclusive deal)/i.test(text),
    mentionsMarket:
      /(pricing|demand|inventory|rates|market|comp|comps|closing|escrow|offer|counter)/i.test(text),
  };

  return signals;
}

function buildVoiceRules(stats: {
  avgLen: number;
  percentQuestions: number;
  percentEmDash: number;
  percentWarm: number;
  percentValue: number;
  percentSoftClose: number;
  percentExclaim: number;
}) {
  const rules: string[] = [];

  // Always true for “Jordan style” per your prior work: short, warm, direct, value.
  rules.push("Keep it short, specific, and human (no corporate filler).");
  rules.push("Warm opener + direct ask/value in the first 1–2 lines.");
  rules.push("Default tone: confident, calm, not salesy; avoid hype language.");

  // Calibrate from stats
  if (stats.percentEmDash >= 25)
    rules.push("Use an em dash (—) occasionally to keep it conversational.");
  if (stats.percentQuestions >= 40) rules.push("Ask 1 clear question instead of multiple.");
  if (stats.percentWarm >= 35)
    rules.push(
      "Include a light check-in (“Quick check-in…”, “Hope you’re well…”) when appropriate.",
    );
  if (stats.percentValue >= 30)
    rules.push("Lead with value: a helpful update, context, or offer to share intel.");
  if (stats.percentSoftClose >= 30)
    rules.push("Close with low-friction language (“No rush”, “Happy to help”).");
  if (stats.percentExclaim < 10) rules.push("Use exclamation sparingly (0–1 max).");

  // Structure
  rules.push("Format: 1) opener, 2) value/ask, 3) soft close. 2–4 sentences max.");
  return rules;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const uid = url.searchParams.get("uid") || "";
    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });

    const limit = Math.max(10, Math.min(200, Number(url.searchParams.get("limit") || 80)));
    const minLen = Math.max(0, Math.min(400, Number(url.searchParams.get("minLen") || 140)));

    // Pull recent-ish examples; you can later add ordering by occurred_at if you want
    const { data, error } = await supabaseAdmin
      .from("user_voice_examples")
      .select(
        "id, channel, intent, contact_category, text, subject, snippet, occurred_at, created_at",
      )
      .eq("user_id", uid)
      .order("occurred_at", { ascending: false })
      .limit(limit);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (data ?? [])
      .map((r) => {
        const raw = (r.text || r.snippet || r.subject || "") as string;
        const text = normalizeWhitespace(raw);
        return {
          id: String(r.id),
          channel: String(r.channel || ""),
          intent: r.intent ? String(r.intent) : null,
          contact_category: r.contact_category ? String(r.contact_category) : null,
          occurred_at: r.occurred_at ? String(r.occurred_at) : null,
          created_at: r.created_at ? String(r.created_at) : null,
          text,
        };
      })
      .filter((r) => r.text.length >= minLen);

    if (rows.length === 0) {
      return NextResponse.json({
        ok: true,
        uid,
        count: 0,
        rules: [
          "No voice examples available yet. Import voice examples from Gmail first.",
          "Once you have ~50 examples, Jordan OS will generate drafts that match your tone.",
        ],
        examples: [],
        stats: null,
      });
    }

    let totalLen = 0;
    let q = 0;
    let em = 0;
    let warm = 0;
    let value = 0;
    let soft = 0;
    let ex = 0;

    // lightweight “signature phrases” extraction
    const phraseCounts = new Map<string, number>();

    for (const r of rows) {
      totalLen += r.text.length;

      const sig = extractSignals(r.text);
      if (sig.hasQuestion) q += 1;
      if (sig.hasEmDash) em += 1;
      if (sig.hasWarm) warm += 1;
      if (sig.hasValue) value += 1;
      if (sig.hasSoftClose) soft += 1;
      if (sig.hasExclamation) ex += 1;

      // count a few common openers/closers (very simple)
      const candidates = [
        "quick note",
        "quick one",
        "quick check-in",
        "checking in",
        "hope you’re well",
        "hope you're well",
        "no rush",
        "no pressure",
        "happy to help",
        "let me know",
      ];

      const t = r.text.toLowerCase();
      for (const c of candidates) {
        if (t.includes(c)) phraseCounts.set(c, (phraseCounts.get(c) || 0) + 1);
      }
    }

    const n = rows.length;
    const stats = {
      avgLen: Math.round(totalLen / n),
      percentQuestions: Math.round((q / n) * 100),
      percentEmDash: Math.round((em / n) * 100),
      percentWarm: Math.round((warm / n) * 100),
      percentValue: Math.round((value / n) * 100),
      percentSoftClose: Math.round((soft / n) * 100),
      percentExclaim: Math.round((ex / n) * 100),
    };

    const rules = buildVoiceRules(stats);

    const topPhrases = Array.from(phraseCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([phrase, count]) => ({ phrase, count }));

    // Provide a compact example set for client-side drafting
    const examples = rows.slice(0, 25).map((r) => ({
      id: r.id,
      channel: r.channel,
      intent: r.intent,
      contact_category: r.contact_category,
      occurred_at: r.occurred_at,
      text: r.text,
      firstNameHint: firstNameFromText(r.text),
      len: r.text.length,
    }));

    return NextResponse.json({
      ok: true,
      uid,
      count: rows.length,
      minLenApplied: minLen,
      stats,
      rules,
      topPhrases,
      examples,
      note: "This endpoint builds a simple voice profile from user_voice_examples. Keep adding examples over time to tighten the style.",
    });
  } catch (e) {
    const se = safeErr(e);
    return NextResponse.json({ error: "Voice profile crashed", details: se }, { status: 500 });
  }
}
