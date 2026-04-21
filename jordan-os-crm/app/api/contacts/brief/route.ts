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

    // Fetch contact
    const { data: contact, error: cErr } = await supabaseAdmin
      .from("contacts")
      .select("display_name, category, tier, client_type, phone, email, notes, ai_context, birthday, close_anniversary, move_in_date, buyer_budget_min, buyer_budget_max, buyer_target_areas")
      .eq("id", contact_id)
      .eq("user_id", uid)
      .maybeSingle();
    if (cErr || !contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

    // Fetch recent touches (last 20)
    const { data: touches } = await supabaseAdmin
      .from("touches")
      .select("channel, direction, occurred_at, intent, summary")
      .eq("contact_id", contact_id)
      .eq("user_id", uid)
      .order("occurred_at", { ascending: false })
      .limit(20);

    // Fetch all deals (active + closed) for full context
    const { data: allDeals } = await supabaseAdmin
      .from("deals")
      .select("address, role, status, price, close_date, notes")
      .eq("contact_id", contact_id)
      .eq("user_id", uid)
      .order("close_date", { ascending: false, nullsFirst: false });
    const activeDeals = (allDeals ?? []).filter((d: any) => !["closed_won", "closed_lost"].includes(d.status));
    const closedDeals = (allDeals ?? []).filter((d: any) => ["closed_won", "closed_lost"].includes(d.status));

    // Fetch upcoming follow-ups
    const today = new Date().toISOString().slice(0, 10);
    const { data: followUps } = await supabaseAdmin
      .from("follow_ups")
      .select("due_date, note")
      .eq("contact_id", contact_id)
      .eq("user_id", uid)
      .gte("due_date", today)
      .order("due_date", { ascending: true })
      .limit(5);

    // Build context for Claude
    const touchSummaries = (touches ?? [])
      .slice(0, 10)
      .map((t: any) => {
        const date = new Date(t.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        const dir = t.direction === "outbound" ? "→" : "←";
        return `${dir} ${t.channel} on ${date}${t.summary ? `: ${t.summary}` : ""}`;
      })
      .join("\n");

    const dealContext = [
      ...activeDeals.map((d: any) => `Active: ${d.role} at ${d.address} (${d.status}${d.price ? `, $${Number(d.price).toLocaleString()}` : ""}${d.close_date ? `, closes ${d.close_date}` : ""})${d.notes ? ` — ${d.notes}` : ""}`),
      ...closedDeals.map((d: any) => `Past: ${d.role} at ${d.address}${d.close_date ? `, closed ${d.close_date}` : ""}${d.price ? `, $${Number(d.price).toLocaleString()}` : ""}`),
    ].join("\n");

    const fuContext = (followUps ?? [])
      .map((f: any) => `${f.due_date}${f.note ? `: ${f.note}` : ""}`)
      .join(", ");

    const contactBlock = [
      `Name: ${contact.display_name}`,
      `Category: ${contact.category}${contact.tier ? `, Tier ${contact.tier}` : ""}`,
      contact.client_type ? `Client type: ${contact.client_type}` : null,
      contact.notes ? `Notes: ${contact.notes}` : null,
      contact.ai_context ? `AI context: ${contact.ai_context}` : null,
      contact.buyer_budget_min || contact.buyer_budget_max ? `Buyer budget: $${contact.buyer_budget_min?.toLocaleString() ?? "?"} – $${contact.buyer_budget_max?.toLocaleString() ?? "?"}` : null,
      contact.buyer_target_areas ? `Target areas: ${contact.buyer_target_areas}` : null,
    ].filter(Boolean).join("\n");

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
    const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

    const system = `You are a concise real estate agent briefing assistant. Given a contact's profile and relationship history, generate a short pre-call/pre-meeting brief.

Format your response as JSON with these exact keys:
{
  "headline": "one sentence capturing who this person is and where the relationship stands",
  "quick_facts": ["3-5 short bullet strings of the most important facts to remember"],
  "recent_context": "1-2 sentences describing the most recent interaction and its outcome",
  "suggested_ask": "the single best conversation-starting question or talking point for right now",
  "watch_out": "one thing to be aware of or sensitive about (or null if nothing notable)"
}

Be direct and practical. Focus on what's actionable right now.`;

    const userMsg = [
      "Contact profile:",
      contactBlock,
      dealContext ? `\nDeals:\n${dealContext}` : "",
      touchSummaries ? `\nRecent touches:\n${touchSummaries}` : "\nNo touch history yet.",
      fuContext ? `\nUpcoming follow-ups: ${fuContext}` : "",
    ].filter(Boolean).join("\n");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        temperature: 0.3,
        system,
        messages: [{ role: "user", content: userMsg }],
      }),
    });

    const j = await res.json();
    if (!res.ok) throw new Error(j?.error?.message || `Anthropic error (${res.status})`);

    const raw = j?.content?.[0]?.text?.trim() ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON in response");

    const brief = JSON.parse(match[0]);
    return NextResponse.json({ brief });
  } catch (e) {
    return serverError("CONTACT_BRIEF_CRASH", e);
  }
}
