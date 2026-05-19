import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const ANTHROPIC_MODEL = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-4-6";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scoreContact(contact: any, notes: any[], touchCount: number, lastTouchDate: string | null): Promise<{ transaction_score: number; rationale: string } | null> {
  let yearsSincePurchase: number | null = null;
  if (contact.purchase_date) {
    const purchaseMs = new Date(contact.purchase_date).getTime();
    yearsSincePurchase = Math.floor((Date.now() - purchaseMs) / (86400000 * 365.25));
  }

  const contactJson = JSON.stringify({
    name: contact.display_name,
    category: contact.category,
    tier: contact.tier,
    life_event_flags: contact.life_event_flags,
    referral_signal_active: contact.referral_signal_active,
    purchase_date: contact.purchase_date,
    purchase_price: contact.purchase_price,
    purchase_neighborhood: contact.purchase_neighborhood,
    estimated_current_value: contact.estimated_current_value,
    years_since_purchase: yearsSincePurchase,
  }, null, 2);

  const notesBlock = notes.length === 0 ? "None" : notes.map((n: any) => {
    const date = new Date(n.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `${date}: ${n.summary ?? "(no summary)"} | sentiment: ${n.sentiment ?? "unknown"} | intent: ${n.transaction_intent ?? "none"} | timeline: ${n.timeline_mentioned ?? "none"} | life events: ${Array.isArray(n.life_event_flags) && n.life_event_flags.length > 0 ? n.life_event_flags.join(", ") : "none"}`;
  }).join("\n");

  const prompt = `You are scoring a real estate contact's likelihood to transact in the next 6 months.
Return ONLY valid JSON. No preamble, no markdown.

Contact data:
${contactJson}

Recent interaction notes:
${notesBlock}

Touch frequency (last 90 days): ${touchCount}
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
- Contact tier (A/B weighted higher)

Return:
{
  "transaction_score": integer 0-100,
  "rationale": "2-3 sentence explanation — be specific, reference actual signals",
  "top_signals": ["array of 2-3 strongest signals driving this score"],
  "suggested_action": "one specific action Jordan should take given this score"
}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) return null;

  const j = await res.json();
  const raw = j?.content?.[0]?.text ?? "";
  try {
    const scored = JSON.parse(raw);
    return { transaction_score: scored.transaction_score, rationale: scored.rationale };
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const scored = JSON.parse(match[0]);
      return { transaction_score: scored.transaction_score, rationale: scored.rationale };
    }
    return null;
  }
}

Deno.serve(async (_req) => {
  try {
    const sixDaysAgo = new Date(Date.now() - 6 * 86400000).toISOString();
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();

    // Fetch scoreable contacts: Tier A/B Clients/Sphere, not recently scored
    const { data: contacts, error: contactsErr } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, life_event_flags, referral_signal_active, purchase_date, purchase_price, purchase_neighborhood, estimated_current_value")
      .in("category", ["Client", "Sphere", "Agent"])
      .in("tier", ["A", "B"])
      .or(`score_updated_at.is.null,score_updated_at.lt.${sixDaysAgo}`)
      .neq("archived", true)
      .order("last_interaction_at", { ascending: false, nullsFirst: false })
      .limit(10);

    if (contactsErr) throw new Error(`Contacts fetch failed: ${contactsErr.message}`);
    if (!contacts || contacts.length === 0) {
      return new Response(JSON.stringify({ ok: true, contacts_scored: 0 }), { headers: { "Content-Type": "application/json" } });
    }

    let scored = 0;
    for (const contact of contacts) {
      try {
        // Fetch interaction notes
        const { data: notes } = await supabase
          .from("interaction_notes")
          .select("summary, sentiment, life_event_flags, transaction_intent, timeline_mentioned, created_at")
          .eq("contact_id", contact.id)
          .order("created_at", { ascending: false })
          .limit(10);

        // Fetch touch count and last touch
        const { data: touches } = await supabase
          .from("touches")
          .select("id, occurred_at")
          .eq("contact_id", contact.id)
          .gte("occurred_at", ninetyDaysAgo)
          .order("occurred_at", { ascending: false });

        const touchCount = touches?.length ?? 0;
        const lastTouchDate = touches && touches.length > 0 ? touches[0].occurred_at : null;

        const result = await scoreContact(contact, notes ?? [], touchCount, lastTouchDate);
        if (result) {
          await supabase.from("contacts").update({
            transaction_score: result.transaction_score,
            transaction_score_rationale: result.rationale,
            score_updated_at: new Date().toISOString(),
          }).eq("id", contact.id);
          scored++;
        }
      } catch (e) {
        console.error(`Failed to score contact ${contact.id}:`, e);
      }

      await sleep(200);
    }

    // Log the run
    await supabase.from("scoring_runs").insert({
      contacts_scored: scored,
      triggered_by: "scheduled",
    });

    return new Response(JSON.stringify({ ok: true, contacts_scored: scored }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message ?? "Unknown error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
