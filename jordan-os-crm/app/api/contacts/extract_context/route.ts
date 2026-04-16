import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

async function claudeExtract(system: string, user: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || `Anthropic error (${res.status})`);
  const text = j?.content?.[0]?.text;
  if (typeof text === "string" && text.trim()) return text.trim();
  throw new Error("Claude returned no text");
}

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { contact_id } = body;

    if (!isUuid(contact_id)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 });

    // Fetch contact
    const { data: contact, error: cErr } = await supabaseAdmin
      .from("contacts")
      .select("id, display_name, category, tier, client_type, notes, user_id, buyer_budget_min, buyer_budget_max, buyer_target_areas, birthday, close_anniversary, move_in_date")
      .eq("id", contact_id)
      .eq("user_id", uid)
      .single();

    if (cErr || !contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

    // Fetch all data sources in parallel
    const [messagesRes, touchesRes, dealsRes] = await Promise.all([
      supabaseAdmin
        .from("text_messages")
        .select("direction, body, occurred_at, created_at")
        .eq("contact_id", contact_id)
        .order("created_at", { ascending: false })
        .limit(200),
      supabaseAdmin
        .from("touches")
        .select("direction, channel, occurred_at, intent, summary")
        .eq("contact_id", contact_id)
        .order("occurred_at", { ascending: false })
        .limit(50),
      supabaseAdmin
        .from("deals")
        .select("address, role, status, price, close_date, notes, created_at")
        .eq("contact_id", contact_id)
        .eq("user_id", uid)
        .order("created_at", { ascending: false }),
    ]);

    const messages = messagesRes.data ?? [];
    const touches = touchesRes.data ?? [];
    const deals = dealsRes.data ?? [];

    const hasMessages = messages.length > 0;
    const hasTouches = touches.filter((t: any) => t.summary).length > 0;
    const hasDeals = deals.length > 0;
    const hasData = hasMessages || hasTouches || hasDeals || contact.notes;

    if (!hasData) {
      return NextResponse.json({ error: "No data to extract from yet — add touches, deals, or notes first" }, { status: 400 });
    }

    const system = `You are extracting relationship intelligence for Jordan Kramer, a luxury Los Angeles real estate advisor.

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

    const profileBlock = [
      `Contact: ${contact.display_name}`,
      `Category: ${contact.category}${contact.tier ? ` · Tier ${contact.tier}` : ""}${contact.client_type ? ` · ${contact.client_type}` : ""}`,
      contact.buyer_budget_min || contact.buyer_budget_max
        ? `Buyer budget: $${(contact.buyer_budget_min as number | null)?.toLocaleString() ?? "?"} – $${(contact.buyer_budget_max as number | null)?.toLocaleString() ?? "?"}`
        : null,
      contact.buyer_target_areas ? `Target areas: ${contact.buyer_target_areas}` : null,
      contact.birthday ? `Birthday: ${contact.birthday}` : null,
      contact.close_anniversary ? `Close anniversary: ${contact.close_anniversary}` : null,
      contact.move_in_date ? `Move-in date: ${contact.move_in_date}` : null,
      contact.notes ? `Agent notes: ${contact.notes}` : null,
    ].filter(Boolean).join("\n");

    const dealBlock = deals
      .map((d: any) => `${d.role} at ${d.address} — ${d.status}${d.price ? `, $${Number(d.price).toLocaleString()}` : ""}${d.close_date ? `, closes ${d.close_date}` : ""}${d.notes ? ` — ${d.notes}` : ""}`)
      .join("\n");

    const touchBlock = touches
      .filter((t: any) => t.summary)
      .map((t: any) => `${t.occurred_at?.slice(0, 10) ?? "?"} via ${t.channel} (${t.intent ?? "—"}): ${t.summary}`)
      .join("\n");

    const msgBlock = messages
      .slice(0, 150)
      .reverse()
      .map((m: any) => `[${m.direction === "outbound" ? "Jordan" : contact.display_name}] ${m.body}`)
      .join("\n");

    const userMsg = [
      profileBlock,
      hasDeals ? `\n--- DEALS ---\n${dealBlock}` : "",
      hasTouches ? `\n--- TOUCH NOTES ---\n${touchBlock}` : "",
      hasMessages ? `\n--- TEXT MESSAGES (oldest → newest) ---\n${msgBlock}` : "",
    ].filter(Boolean).join("\n");

    let extracted: string;
    try {
      extracted = await claudeExtract(system, userMsg);
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || "Extraction failed" }, { status: 500 });
    }

    // Save to contact
    const { error: uErr } = await supabaseAdmin
      .from("contacts")
      .update({
        ai_context: extracted,
        ai_context_updated_at: new Date().toISOString(),
      })
      .eq("id", contact_id);

    if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });

    return NextResponse.json({
      ok: true,
      contact_id,
      ai_context: extracted,
      sources: {
        messages: messages.length,
        touch_notes: touches.filter((t: any) => t.summary).length,
        deals: deals.length,
      },
    });
  } catch (e) {
    return serverError("EXTRACT_CONTEXT_CRASH", e);
  }
}
