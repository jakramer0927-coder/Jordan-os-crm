// Batch-run ai_context extraction + transaction scoring over all active contacts.
// Mirrors the prompts/logic of /api/contacts/extract_context and /api/contacts/score.
//
// Usage: node scripts/batch_score.mjs [--dry-run] [--limit N]
// Reads .env.local for SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY,
// ANTHROPIC_MODEL, JORDAN_OS_USER_ID.

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Local runs read .env.local; CI (GitHub Actions) supplies env vars directly.
const envFile = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

for (const required of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "JORDAN_OS_USER_ID"]) {
  if (!process.env[required]) {
    console.error(`Missing required env var: ${required}`);
    process.exit(1);
  }
}

const DRY = process.argv.includes("--dry-run");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;
const CONCURRENCY = 2;
const STALE_DAYS = 14; // skip items refreshed within this window

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const uid = process.env.JORDAN_OS_USER_ID;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

async function claude(system, user, maxTokens) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        temperature: 0.2,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: user }],
      }),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, attempt * 5000));
      continue;
    }
    const j = await res.json();
    if (!res.ok) throw new Error(j?.error?.message || `Anthropic error ${res.status}`);
    return j?.content?.[0]?.text ?? "";
  }
  throw new Error("Anthropic: retries exhausted");
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) return JSON.parse(m[0]);
  throw new Error("No JSON in model output");
}

const EXTRACT_SYSTEM = `You are extracting relationship intelligence for Jordan Kramer, a luxury Los Angeles real estate advisor.

Your job: read all available data about this contact and produce a concise, factual relationship summary.

Output format — use these sections (only include sections where you have real data):

**Real estate context**
What they're working on, areas of interest, budget/price range, timeline, buyer/seller status, specific properties discussed, deal status.

**Personal context**
Family details, job/company, life events mentioned, interests, upcoming milestones — anything that helps Jordan connect personally.

**Relationship history**
Key interactions, decisions made, commitments, patterns in the relationship.

**Open items**
Things promised, questions to ask next time, follow-through needed.

Rules:
- Only state facts found in the data. Never invent or infer beyond what's there.
- Be concise. Use bullet points within each section.
- Skip any section with nothing to say.
- Do not add filler or meta-commentary.`;

async function extractContext(c) {
  const [messagesRes, touchesRes, dealsRes] = await Promise.all([
    supabase.from("text_messages").select("direction, body, created_at")
      .eq("contact_id", c.id).order("created_at", { ascending: false }).limit(200),
    supabase.from("touches").select("direction, channel, occurred_at, intent, summary")
      .eq("contact_id", c.id).order("occurred_at", { ascending: false }).limit(50),
    supabase.from("deals").select("address, role, status, price, close_date, notes, created_at")
      .eq("contact_id", c.id).eq("user_id", uid).order("created_at", { ascending: false }),
  ]);
  const messages = messagesRes.data ?? [];
  const touches = (touchesRes.data ?? []).filter((t) => t.summary);
  const deals = dealsRes.data ?? [];
  if (messages.length === 0 && touches.length === 0 && deals.length === 0 && !c.notes) {
    return { skipped: "no data" };
  }

  const profileBlock = [
    `Contact: ${c.display_name}`,
    `Category: ${c.category}${c.tier ? ` · Tier ${c.tier}` : ""}${c.client_type ? ` · ${c.client_type}` : ""}`,
    c.buyer_budget_min || c.buyer_budget_max
      ? `Buyer budget: $${c.buyer_budget_min?.toLocaleString() ?? "?"} – $${c.buyer_budget_max?.toLocaleString() ?? "?"}`
      : null,
    c.buyer_target_areas ? `Target areas: ${c.buyer_target_areas}` : null,
    c.birthday ? `Birthday: ${c.birthday}` : null,
    c.close_anniversary ? `Close anniversary: ${c.close_anniversary}` : null,
    c.move_in_date ? `Move-in date: ${c.move_in_date}` : null,
    c.notes ? `Agent notes: ${c.notes}` : null,
  ].filter(Boolean).join("\n");

  const dealBlock = deals.map((d) =>
    `${d.role} at ${d.address} — ${d.status}${d.price ? `, $${Number(d.price).toLocaleString()}` : ""}${d.close_date ? `, closes ${d.close_date}` : ""}${d.notes ? ` — ${d.notes}` : ""}`).join("\n");
  const touchBlock = touches.map((t) =>
    `${t.occurred_at?.slice(0, 10) ?? "?"} via ${t.channel} (${t.intent ?? "—"}): ${t.summary}`).join("\n");
  const msgBlock = messages.slice(0, 150).reverse().map((m) =>
    `[${m.direction === "outbound" ? "Jordan" : c.display_name}] ${m.body}`).join("\n");

  const userMsg = [
    profileBlock,
    deals.length ? `\n--- DEALS ---\n${dealBlock}` : "",
    touches.length ? `\n--- TOUCH NOTES ---\n${touchBlock}` : "",
    messages.length ? `\n--- TEXT MESSAGES (oldest → newest) ---\n${msgBlock}` : "",
  ].filter(Boolean).join("\n");

  if (DRY) return { dryRun: true };
  const extracted = await claude(EXTRACT_SYSTEM, userMsg, 1024);
  await supabase.from("contacts")
    .update({ ai_context: extracted, ai_context_updated_at: new Date().toISOString() })
    .eq("id", c.id);
  return { ok: true };
}

async function scoreContact(c) {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();
  const [notesRes, touchesRes, dealsRes, freshRes] = await Promise.all([
    supabase.from("interaction_notes")
      .select("summary, sentiment, life_event_flags, transaction_intent, timeline_mentioned, created_at")
      .eq("contact_id", c.id).order("created_at", { ascending: false }).limit(10),
    supabase.from("touches").select("id, occurred_at").eq("contact_id", c.id).gte("occurred_at", ninetyDaysAgo),
    supabase.from("deals").select("address, role, status, buyer_stage, seller_stage, opp_type, price")
      .eq("contact_id", c.id).eq("user_id", uid)
      .not("status", "in", '("closed_won","closed_lost","sold")'),
    supabase.from("contacts").select("ai_context").eq("id", c.id).single(),
  ]);
  const notes = notesRes.data ?? [];
  const touches = touchesRes.data ?? [];
  const activeDeals = dealsRes.data ?? [];
  const aiContext = freshRes.data?.ai_context ?? c.ai_context;

  let yearsSincePurchase = null;
  if (c.purchase_date) {
    yearsSincePurchase = Math.floor((Date.now() - new Date(c.purchase_date).getTime()) / (86400000 * 365.25));
  }
  const lastTouchDate = touches.length > 0
    ? touches.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))[0].occurred_at
    : null;

  const contactJson = JSON.stringify({
    name: c.display_name,
    category: c.category,
    tier: c.tier,
    client_type: c.client_type,
    notes: c.notes,
    ai_context: aiContext,
    life_event_flags: c.life_event_flags,
    referral_signal_active: c.referral_signal_active,
    purchase_date: c.purchase_date,
    purchase_price: c.purchase_price,
    purchase_neighborhood: c.purchase_neighborhood,
    estimated_current_value: c.estimated_current_value,
    years_since_purchase: yearsSincePurchase,
    active_deals: activeDeals.map((d) => `${d.opp_type ?? d.role}: ${d.address} (${d.buyer_stage ?? d.seller_stage ?? d.status})`),
  }, null, 2);

  const notesBlock = notes.length === 0 ? "None" : notes.map((n) => {
    const date = new Date(n.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${date}: ${n.summary ?? "(no summary)"} | sentiment: ${n.sentiment ?? "unknown"} | intent: ${n.transaction_intent ?? "none"} | timeline: ${n.timeline_mentioned ?? "none"} | life events: ${Array.isArray(n.life_event_flags) && n.life_event_flags.length > 0 ? n.life_event_flags.join(", ") : "none"}`;
  }).join("\n");

  const prompt = `You are scoring a real estate contact's likelihood to transact in the next 6 months.
Return ONLY valid JSON. No preamble, no markdown.

Contact data:
${contactJson}

Recent interaction notes:
${notesBlock}

Touch frequency (last 90 days): ${touches.length}
Last touch date: ${lastTouchDate ? new Date(lastTouchDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Never"}

Score this contact 0–100 where:
0–30 = unlikely to transact soon
31–60 = possible but no strong signals
61–80 = moderate signals, worth prioritizing
81–100 = strong signals, high likelihood

Weigh these factors:
- Years since purchase (4–8 years in LA = move-up sweet spot)
- Any explicit transaction intent or timeline mentioned
- Life event flags (job change, new baby, divorce, relocation = strong triggers)
- Referral signal active
- Recency and sentiment of recent interactions
- Contact status tier (A/B weighted higher)

Return:
{
  "transaction_score": integer 0-100,
  "rationale": "2-3 sentence explanation — be specific, reference actual signals",
  "top_signals": ["array of 2-3 strongest signals driving this score"],
  "suggested_action": "one specific action Jordan should take given this score"
}`;

  if (DRY) return { dryRun: true };
  const scored = parseJson(await claude(null, prompt, 500));
  await supabase.from("contacts").update({
    transaction_score: scored.transaction_score ?? null,
    transaction_score_rationale: scored.rationale ?? null,
    score_updated_at: new Date().toISOString(),
  }).eq("id", c.id);
  return { ok: true, score: scored.transaction_score };
}

async function runPool(items, worker, label) {
  let done = 0, ok = 0, skipped = 0, failed = 0;
  let firstError = null;
  const queue = [...items];
  async function next() {
    const item = queue.shift();
    if (!item) return;
    try {
      const r = await worker(item);
      if (r?.skipped) skipped++;
      else ok++;
      done++;
      if (done % 20 === 0) console.log(`  [${label}] ${done}/${items.length}`);
    } catch (e) {
      failed++;
      done++;
      if (!firstError) firstError = e.message;
      console.error(`  [${label}] FAIL ${item.display_name}: ${e.message}`);
    }
    await next();
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, next));
  console.log(`[${label}] done: ${ok} ok, ${skipped} skipped, ${failed} failed`);
  return { ok, skipped, failed, firstError };
}

const staleCutoff = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();

const { data: contacts, error } = await supabase
  .from("contacts")
  .select("id, display_name, category, tier, client_type, notes, ai_context, ai_context_updated_at, score_updated_at, life_event_flags, referral_signal_active, purchase_date, purchase_price, purchase_neighborhood, estimated_current_value, buyer_budget_min, buyer_budget_max, buyer_target_areas, birthday, close_anniversary, move_in_date")
  .eq("user_id", uid)
  .eq("archived", false);
if (error) throw new Error(error.message);

if (contacts.length === 0) {
  console.error(
    `No active contacts found for JORDAN_OS_USER_ID=${uid}. ` +
    `This almost always means the user id is wrong (it must be the auth user id that owns the contacts). ` +
    `Failing instead of reporting a misleading success.`
  );
  process.exit(1);
}

const toExtract = contacts
  .filter((c) => !c.ai_context_updated_at || c.ai_context_updated_at < staleCutoff)
  .slice(0, LIMIT);
const toScore = contacts
  .filter((c) => !c.score_updated_at || c.score_updated_at < staleCutoff)
  .slice(0, LIMIT);

console.log(`Active contacts: ${contacts.length} | extract: ${toExtract.length} | score: ${toScore.length} | model: ${MODEL}${DRY ? " | DRY RUN" : ""}`);

const extractRes = await runPool(toExtract, extractContext, "extract");
const scoreRes = await runPool(toScore, scoreContact, "score");

const { data: after } = await supabase
  .from("contacts")
  .select("transaction_score")
  .eq("user_id", uid).eq("archived", false).not("transaction_score", "is", null);
console.log(`Contacts with score after run: ${after?.length ?? "?"}/${contacts.length}`);

// A run where every attempted item failed is a config problem (usually a bad
// ANTHROPIC_API_KEY) — exit red instead of reporting a hollow success.
const attempted = extractRes.ok + extractRes.failed + scoreRes.ok + scoreRes.failed;
const succeeded = extractRes.ok + scoreRes.ok;
if (attempted > 0 && succeeded === 0) {
  console.error(
    `Every attempted item failed (${attempted} attempts, 0 successes). ` +
    `First error: ${extractRes.firstError ?? scoreRes.firstError ?? "unknown"}`
  );
  process.exit(1);
}
