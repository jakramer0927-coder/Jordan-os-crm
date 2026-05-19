import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

// POST /api/contacts/brief  { contact_id }
export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { contact_id } = body;
    if (!contact_id) return NextResponse.json({ error: "contact_id required" }, { status: 400 });

    // Parallel data fetch
    const [contactRes, touchesRes, dealsRes, notesRes] = await Promise.all([
      supabaseAdmin
        .from("contacts")
        .select("display_name, category, tier, client_type, phone, email, notes, ai_context, birthday, close_anniversary, move_in_date, buyer_budget_min, buyer_budget_max, buyer_target_areas, referral_signal_active, last_referral_ask_date, referral_ask_count, life_event_flags, created_at")
        .eq("id", contact_id)
        .eq("user_id", uid)
        .maybeSingle(),
      supabaseAdmin
        .from("touches")
        .select("channel, direction, occurred_at, intent, summary")
        .eq("contact_id", contact_id)
        .order("occurred_at", { ascending: false })
        .limit(10),
      supabaseAdmin
        .from("deals")
        .select("address, role, status, buyer_stage, seller_stage, price, close_date, notes, opp_type")
        .eq("contact_id", contact_id)
        .eq("user_id", uid)
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("interaction_notes")
        .select("summary, action_items, life_event_flags, sentiment, transaction_intent, timeline_mentioned, created_at")
        .eq("contact_id", contact_id)
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

    const contact = contactRes.data;
    if (contactRes.error || !contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

    const touches = touchesRes.data ?? [];
    const allDeals = dealsRes.data ?? [];
    const interactionNotes = notesRes.data ?? [];

    const activeDeals = allDeals.filter((d: any) => !["closed_won", "closed_lost", "sold"].includes(d.status ?? ""));
    const closedDeals = allDeals.filter((d: any) => ["closed_won", "closed_lost", "sold"].includes(d.status ?? ""));

    // Format context blocks
    const touchBlock = touches.length === 0 ? "None" : touches.map((t: any) => {
      const date = new Date(t.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      const dir = t.direction === "outbound" ? "→" : "←";
      return `${dir} ${t.channel} on ${date}${t.intent ? ` [${t.intent}]` : ""}${t.summary ? `: ${t.summary}` : ""}`;
    }).join("\n");

    const dealBlock = activeDeals.length === 0 && closedDeals.length === 0 ? "None" : [
      ...activeDeals.map((d: any) => {
        const stage = d.buyer_stage ?? d.seller_stage ?? d.status;
        return `Active ${d.opp_type ?? d.role}: ${d.address} — ${stage}${d.price ? ` ($${Number(d.price).toLocaleString()})` : ""}${d.notes ? ` — ${d.notes}` : ""}`;
      }),
      ...closedDeals.map((d: any) => `Closed ${d.opp_type ?? d.role}: ${d.address}${d.close_date ? `, ${d.close_date}` : ""}${d.price ? ` ($${Number(d.price).toLocaleString()})` : ""}`),
    ].join("\n");

    const notesBlock = interactionNotes.length === 0 ? "None" : interactionNotes.map((n: any) => {
      const date = new Date(n.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      const items = Array.isArray(n.action_items) && n.action_items.length > 0 ? ` Actions: ${n.action_items.join("; ")}` : "";
      const flags = Array.isArray(n.life_event_flags) && n.life_event_flags.length > 0 ? ` Life events: ${n.life_event_flags.join(", ")}` : "";
      return `${date}: ${n.summary ?? "(no summary)"}${items}${flags}${n.timeline_mentioned ? ` Timeline: ${n.timeline_mentioned}` : ""}`;
    }).join("\n");

    const contactJson = JSON.stringify({
      name: contact.display_name,
      category: contact.category,
      tier: contact.tier,
      client_type: contact.client_type,
      email: contact.email,
      phone: contact.phone,
      notes: contact.notes,
      ai_context: contact.ai_context,
      life_event_flags: contact.life_event_flags,
      referral_signal_active: contact.referral_signal_active,
      last_referral_ask_date: contact.last_referral_ask_date,
      referral_ask_count: contact.referral_ask_count,
      buyer_budget_min: contact.buyer_budget_min,
      buyer_budget_max: contact.buyer_budget_max,
      buyer_target_areas: contact.buyer_target_areas,
      in_crm_since: contact.created_at?.slice(0, 10),
    }, null, 2);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

    const prompt = `You are preparing a pre-meeting intelligence brief for Jordan, a luxury real estate agent in Los Angeles.
Jordan is about to speak with this contact. Be specific, concise, and direct.
Jordan reads this in 60 seconds before a call — no fluff.

Contact data:
${contactJson}

Recent interaction notes:
${notesBlock}

Recent touches:
${touchBlock}

Active deals:
${dealBlock}

Produce a brief with exactly these sections:

**Relationship Snapshot**
2-3 sentences. Who is this person to Jordan, how long they've known each other, what's the history.

**Current Mindset**
1-2 sentences. Where they likely are based on timing, recent interactions, and any signals.

**What They Care About**
3-5 bullet points. Known priorities, preferences, concerns, hot buttons.

**Suggested Agenda**
3-4 bullet points. What to cover in this specific conversation given current context.

**Referral Opportunity**
1 sentence. Is there a natural referral ask here right now? Why or why not.

**Watch Out For**
1-2 sentences. Any tension, sensitivity, known objection, or thing to avoid.

Be specific. Use names, properties, dates when available. Generic observations are useless.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const j = await res.json();
    if (!res.ok) throw new Error(j?.error?.message || `Anthropic error (${res.status})`);

    const brief_text = j?.content?.[0]?.text?.trim() ?? "";
    return NextResponse.json({ brief_text });
  } catch (e) {
    return serverError("CONTACT_BRIEF_CRASH", e);
  }
}
