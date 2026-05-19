import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { contact_id } = body;
    if (!contact_id) return NextResponse.json({ error: "contact_id required" }, { status: 400 });

    const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000).toISOString();

    // Fetch all data in parallel
    const [contactRes, notesRes, touchCountRes, dealsRes] = await Promise.all([
      supabaseAdmin
        .from("contacts")
        .select("display_name, category, tier, client_type, notes, ai_context, life_event_flags, referral_signal_active, purchase_date, purchase_price, purchase_neighborhood, estimated_current_value, last_interaction_at, created_at")
        .eq("id", contact_id)
        .eq("user_id", uid)
        .single(),
      supabaseAdmin
        .from("interaction_notes")
        .select("summary, sentiment, life_event_flags, transaction_intent, timeline_mentioned, created_at")
        .eq("contact_id", contact_id)
        .order("created_at", { ascending: false })
        .limit(10),
      supabaseAdmin
        .from("touches")
        .select("id, occurred_at")
        .eq("contact_id", contact_id)
        .gte("occurred_at", ninetyDaysAgo),
      supabaseAdmin
        .from("deals")
        .select("address, role, status, buyer_stage, seller_stage, opp_type, price")
        .eq("contact_id", contact_id)
        .eq("user_id", uid)
        .not("status", "in", '("closed_won","closed_lost","sold")'),
    ]);

    if (contactRes.error || !contactRes.data) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    const contact = contactRes.data;
    const notes = notesRes.data ?? [];
    const touches = touchCountRes.data ?? [];
    const activeDeals = dealsRes.data ?? [];

    // Compute years since purchase
    let yearsSincePurchase: number | null = null;
    if (contact.purchase_date) {
      const purchaseMs = new Date(contact.purchase_date).getTime();
      yearsSincePurchase = Math.floor((Date.now() - purchaseMs) / (86400000 * 365.25));
    }

    // Find last touch date
    const lastTouchDate = touches.length > 0
      ? touches.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime())[0].occurred_at
      : null;

    const contactJson = JSON.stringify({
      name: contact.display_name,
      category: contact.category,
      tier: contact.tier,
      client_type: contact.client_type,
      notes: contact.notes,
      ai_context: contact.ai_context,
      life_event_flags: contact.life_event_flags,
      referral_signal_active: contact.referral_signal_active,
      purchase_date: contact.purchase_date,
      purchase_price: contact.purchase_price,
      purchase_neighborhood: contact.purchase_neighborhood,
      estimated_current_value: contact.estimated_current_value,
      years_since_purchase: yearsSincePurchase,
      active_deals: activeDeals.map(d => `${d.opp_type ?? d.role}: ${d.address} (${d.buyer_stage ?? d.seller_stage ?? d.status})`),
    }, null, 2);

    const notesBlock = notes.length === 0 ? "None" : notes.map((n: any) => {
      const date = new Date(n.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      return `${date}: ${n.summary ?? "(no summary)"} | sentiment: ${n.sentiment ?? "unknown"} | intent: ${n.transaction_intent ?? "none"} | timeline: ${n.timeline_mentioned ?? "none"} | life events: ${Array.isArray(n.life_event_flags) && n.life_event_flags.length > 0 ? n.life_event_flags.join(", ") : "none"}`;
    }).join("\n");

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "Missing ANTHROPIC_API_KEY" }, { status: 500 });

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

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return NextResponse.json({ error: `Claude error: ${errText}` }, { status: 502 });
    }

    const claudeJson = await claudeRes.json();
    const rawOutput = claudeJson?.content?.[0]?.text ?? "";

    let scored: any = {};
    try {
      scored = JSON.parse(rawOutput);
    } catch {
      const match = rawOutput.match(/\{[\s\S]*\}/);
      if (match) scored = JSON.parse(match[0]);
    }

    // Write score back to contacts
    await supabaseAdmin.from("contacts").update({
      transaction_score: scored.transaction_score ?? null,
      transaction_score_rationale: scored.rationale ?? null,
      score_updated_at: new Date().toISOString(),
    }).eq("id", contact_id);

    return NextResponse.json({
      transaction_score: scored.transaction_score,
      rationale: scored.rationale,
      top_signals: scored.top_signals ?? [],
      suggested_action: scored.suggested_action ?? null,
    });
  } catch (e) {
    return serverError("CONTACT_SCORE_CRASH", e);
  }
}
