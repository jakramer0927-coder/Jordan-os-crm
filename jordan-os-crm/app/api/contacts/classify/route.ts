import { NextResponse } from "next/server";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

type ContactInput = {
  id: string;
  display_name: string;
  email?: string | null;
  company?: string | null;
  notes?: string | null;
  category?: string | null;
};

type Suggestion = {
  id: string;
  category: string;
  tier: string;
  reason: string;
};

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const contacts: ContactInput[] = Array.isArray(body.contacts) ? body.contacts.slice(0, 30) : [];

    if (contacts.length === 0) {
      return NextResponse.json({ suggestions: [] });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY");
    const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

    const contactList = contacts
      .map((c) => {
        const parts = [`id: ${c.id}`, `name: ${c.display_name}`];
        if (c.email) parts.push(`email: ${c.email}`);
        if (c.company) parts.push(`company: ${c.company}`);
        if (c.category && c.category !== "other") parts.push(`existing_category: ${c.category}`);
        if (c.notes) parts.push(`notes: ${c.notes.slice(0, 300)}`);
        return parts.join(" | ");
      })
      .join("\n");

    const systemPrompt = `You classify real estate contacts for a luxury LA agent's CRM.

CATEGORIES (pick one):
- Agent: real estate agents, brokers, Realtors — look for brokerage email domains (compass.com, theagencyre.com, elliman.com, sothebys.realty, coldwellbanker.com, kw.com, bhhs.com, carolwoodre.com, ohanare.com, rodeo.com, nourmand.com, weahomes.com, etc.)
- Client: buyers, sellers, or renters the agent has worked with or is actively working with
- Developer: property developers who buy/build/flip multiple properties (not typical home buyers)
- Vendor: service providers — escrow, title, inspector, contractor, stager, photographer, cleaner, lender, insurance
- Sphere: personal network — family, friends, non-RE professionals who are referral sources
- Other: truly unclear — use sparingly

TIERS (pick one):
- A: Monthly contact — best clients, closest referral agents, top sphere (family, close friends)
- B: Every 60 days — solid agents, past clients, good sphere connections
- C: Every 90 days — dormant contacts, one-time interactions, low-priority relationships

KEY SIGNALS:
- compass.com / theagencyre.com / elliman.com etc. email → Agent
- gmail/icloud/yahoo/hotmail email + notes about buying/selling → Client
- notes mention "COE", "purchase", "sold", "buyer", "listing" → Client
- notes mention "family", "friend", "sister", "brother" → Sphere tier A or B
- company is a brokerage → Agent
- Compass status "Engaged" → tier A or B; "Inactive" → tier C
- existing_category provided → strongly prefer to keep it, just assign tier
- No touch history, unclear context → tier B or C

Return ONLY a valid JSON array. No markdown, no explanation, no other text:
[{"id":"...","category":"Agent","tier":"B","reason":"compass.com email"},...]`;

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
        system: systemPrompt,
        messages: [{ role: "user", content: `Classify these ${contacts.length} contacts:\n\n${contactList}` }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Claude API error: ${err}`);
    }

    const data = await res.json();
    const raw = data.content?.[0]?.text || "[]";

    let suggestions: Suggestion[] = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        suggestions = parsed.filter(
          (s: any) =>
            typeof s.id === "string" &&
            typeof s.category === "string" &&
            typeof s.tier === "string"
        );
      }
    } catch {
      // If Claude returned garbled JSON, fall back to empty
    }

    return NextResponse.json({ suggestions });
  } catch (e) {
    return serverError("CLASSIFY_CRASH", e);
  }
}
