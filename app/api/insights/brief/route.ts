import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUser, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const user = await getVerifiedUser();
    if (!user) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { summary } = body;
    if (!summary?.trim()) return NextResponse.json({ error: "summary required" }, { status: 400 });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return NextResponse.json({ error: "Missing ANTHROPIC_API_KEY" }, { status: 500 });

    const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

    // Load per-user agent context from user_settings
    const { data: settings } = await supabaseAdmin
      .from("user_settings")
      .select("agent_name, agent_context")
      .eq("user_id", user.id)
      .maybeSingle();

    const agentName = (settings as any)?.agent_name || user.name || user.email?.split("@")[0] || "this agent";
    const agentContext = (settings as any)?.agent_context || "";

    const contextBlock = agentContext
      ? `Agent context: ${agentContext}`
      : `Agent: ${agentName}, real estate professional.`;

    const system = `You are a candid business analyst for a real estate agent.
${contextBlock}

Write a candid 4–5 sentence business brief covering:
1. What's genuinely strong in the data
2. The biggest risk or gap you see
3. One non-obvious pattern worth paying attention to
4. One specific, actionable recommendation

Use their actual numbers. Be direct — no hedging, no filler. Write in second person ("Your pipeline…", "You have…"). Do not use bullet points — write in prose.`;

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
        messages: [{ role: "user", content: summary.trim() }],
      }),
    });

    const j = await res.json();
    if (!res.ok) throw new Error(j?.error?.message || `Anthropic error (${res.status})`);

    const brief = j?.content?.[0]?.text?.trim() ?? "";
    return NextResponse.json({ brief });
  } catch (e) {
    return serverError("INSIGHTS_BRIEF_CRASH", e);
  }
}
