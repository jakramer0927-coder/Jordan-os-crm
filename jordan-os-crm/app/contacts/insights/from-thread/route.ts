import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(v);
}

type Body = {
  uid: string;
  contact_id: string;
  thread_id: string;
};

function daysFromNow(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

function extractInsights(messages: { body: string; direction: string }[]) {
  const insights: { kind: string; value: string }[] = [];
  const drafts: { intent: string; draft: string }[] = [];

  const combined = messages.map((m) => m.body).join("\n");

  // --- Heuristic open loop detection ---
  const lastOutbound = [...messages].reverse().find((m) => m.direction === "outbound");

  if (lastOutbound && lastOutbound.body.trim().endsWith("?")) {
    insights.push({
      kind: "open_loop",
      value: `Unanswered question: "${lastOutbound.body.slice(0, 120)}"`,
    });

    drafts.push({
      intent: "check_in",
      draft: `Hey — just wanted to circle back on this. Let me know what you ended up deciding.`,
    });
  }

  // --- Appliance / home project detection ---
  if (/bosch|appliance|dishwasher|reno|remodel|costco/i.test(combined)) {
    insights.push({
      kind: "project",
      value: "Discussed appliances / potential renovation decisions.",
    });

    drafts.push({
      intent: "value",
      draft: `If helpful, I can send over a couple solid appliance resources I've seen clients use recently.`,
    });
  }

  return { insights, drafts };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const { uid, contact_id, thread_id } = body;

    if (!isUuid(uid) || !isUuid(contact_id) || !isUuid(thread_id)) {
      return NextResponse.json({ error: "Invalid IDs" }, { status: 400 });
    }

    // 1️⃣ Fetch thread messages
    const { data: messages, error: msgErr } = await supabaseAdmin
      .from("text_messages")
      .select("body, direction")
      .eq("thread_id", thread_id)
      .order("created_at", { ascending: true });

    if (msgErr || !messages) {
      return NextResponse.json({ error: msgErr?.message }, { status: 500 });
    }

    const { insights, drafts } = extractInsights(messages);

    // 2️⃣ Insert insights — skip any already extracted from this thread
    if (insights.length > 0) {
      const { data: existing } = await supabaseAdmin
        .from("contact_insights")
        .select("kind")
        .eq("contact_id", contact_id)
        .eq("source_thread_id", thread_id);

      const existingKinds = new Set((existing ?? []).map((r: { kind: string }) => r.kind));
      const newInsights = insights.filter((i) => !existingKinds.has(i.kind));

      if (newInsights.length > 0) {
        await supabaseAdmin.from("contact_insights").insert(
          newInsights.map((i) => ({
            user_id: uid,
            contact_id,
            source_thread_id: thread_id,
            kind: i.kind,
            value: i.value,
          })),
        );
      }
    }

    // 3️⃣ Insert drafts — skip if this thread already produced drafts
    const { data: existingDrafts } = await supabaseAdmin
      .from("contact_drafts")
      .select("id")
      .eq("contact_id", contact_id)
      .eq("source_thread_id", thread_id)
      .limit(1);

    if (drafts.length > 0 && (!existingDrafts || existingDrafts.length === 0)) {
      await supabaseAdmin.from("contact_drafts").insert(
        drafts.map((d) => ({
          user_id: uid,
          contact_id,
          source_thread_id: thread_id,
          channel: "text",
          intent: d.intent,
          draft: d.draft,
        })),
      );
    }

    // 4️⃣ Only update next_action if it is currently null — never overwrite existing value
    await supabaseAdmin
      .from("contacts")
      .update({
        next_action: "Follow up on recent conversation",
        next_action_due_at: daysFromNow(5),
      })
      .eq("id", contact_id)
      .is("next_action", null);

    return NextResponse.json({
      ok: true,
      insights_found: insights.length,
      drafts_found: drafts.length,
    });
  } catch (e) {
    return NextResponse.json({ error: "Insight extraction failed" }, { status: 500 });
  }
}
