import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

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

type Intent =
    | "check_in"
    | "follow_up"
    | "scheduling"
    | "referral_ask"
    | "review_ask"
    | "deal_update"
    | "vendor_coordination"
    | "other";

type Body = {
    contact_id: string;
    channel?: "text" | "email" | null;
    ask?: string | null;
    key_points?: string[] | null;
};

function clip(s: string, max = 1400) {
    const t = (s || "").trim();
    if (t.length <= max) return t;
    return t.slice(0, max) + "…";
}

export async function POST(req: Request) {
    try {
        const uid = await getVerifiedUid();
        if (!uid) return unauthorized();

        const body = (await req.json()) as Body;

        const contact_id = body?.contact_id || "";
        const channel = (body?.channel || "text") as "text" | "email";
        const ask = (body?.ask || "").trim();
        const key_points = (body?.key_points || []).filter(Boolean).slice(0, 12);

        if (!isUuid(contact_id)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 });

        // Pull contact
        const { data: cData, error: cErr } = await supabaseAdmin
            .from("contacts")
            .select("id, display_name, category, tier, client_type, company, notes")
            .eq("id", contact_id)
            .eq("user_id", uid)
            .single();

        if (cErr || !cData) {
            return NextResponse.json({ error: cErr?.message || "Contact not found" }, { status: 404 });
        }

        // Recent touches
        const { data: tData } = await supabaseAdmin
            .from("touches")
            .select("occurred_at, channel, direction, intent, summary")
            .eq("contact_id", contact_id)
            .order("occurred_at", { ascending: false })
            .limit(25);

        // Recent text messages (if you have them attached to contact_id)
        const { data: mData } = await supabaseAdmin
            .from("text_messages")
            .select("occurred_at, direction, sender, body, created_at")
            .eq("user_id", uid)
            .eq("contact_id", contact_id)
            .order("created_at", { ascending: false })
            .limit(30);

        const contactSummary = {
            display_name: cData.display_name,
            category: cData.category,
            tier: cData.tier,
            client_type: cData.client_type,
            company: cData.company,
            notes: cData.notes,
        };

        const recentTouches = (tData ?? []).map((t: any) => ({
            occurred_at: t.occurred_at,
            channel: t.channel,
            direction: t.direction,
            intent: t.intent,
            summary: clip(t.summary || "", 240),
        }));

        const recentTexts = (mData ?? []).map((m: any) => ({
            occurred_at: m.occurred_at || m.created_at,
            direction: m.direction,
            sender: m.sender,
            body: clip(m.body || "", 320),
        }));

        const system = `You are an assistant that classifies the user's message intent for a personal CRM.
Return STRICT JSON only (no markdown), matching this schema:
{
  "intent": one of ["check_in","follow_up","scheduling","referral_ask","review_ask","deal_update","vendor_coordination","other"],
  "confidence": number 0..1,
  "reason": string,
  "suggested_key_points": string[] (0-6),
  "suggested_ask": string (optional, short)
}
Rules:
- Pick the closest intent for what the user is trying to send now.
- If unclear, choose "other" with lower confidence.
- suggested_key_points should be concise bullets without hyphens.
- suggested_ask should be one sentence max.`;

        const user = {
            channel,
            contact: contactSummary,
            user_draft_input: {
                ask: ask || null,
                key_points: key_points.length ? key_points : null,
            },
            recent_touches: recentTouches,
            recent_texts: recentTexts,
        };

        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });

        // Chat Completions API  [oai_citation:1‡OpenAI Platform](https://platform.openai.com/docs/api-reference/chat?_clear=true&lang=node.js&utm_source=chatgpt.com)
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
                temperature: 0.2,
                response_format: { type: "json_object" },
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: JSON.stringify(user) },
                ],
            }),
        });

        const j = await resp.json();
        if (!resp.ok) {
            return NextResponse.json({ error: j?.error?.message || "OpenAI error", details: j }, { status: 500 });
        }

        const content = j?.choices?.[0]?.message?.content || "{}";

        let parsed: any = {};
        try {
            parsed = JSON.parse(content);
        } catch {
            parsed = {};
        }

        // Hard guardrails
        const allowed = new Set<Intent>([
            "check_in",
            "follow_up",
            "scheduling",
            "referral_ask",
            "review_ask",
            "deal_update",
            "vendor_coordination",
            "other",
        ]);

        const intent = allowed.has(parsed.intent) ? parsed.intent : "other";
        const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.55;

        return NextResponse.json({
            ok: true,
            intent,
            confidence,
            reason: String(parsed.reason || ""),
            suggested_key_points: Array.isArray(parsed.suggested_key_points)
                ? parsed.suggested_key_points.map((x: any) => String(x)).slice(0, 6)
                : [],
            suggested_ask: parsed.suggested_ask ? String(parsed.suggested_ask) : null,
        });
    } catch (e) {
        const se = safeErr(e);
        console.error("VOICE_SUGGEST_INTENT_CRASH", se);
        return NextResponse.json({ error: "Suggest intent crashed", details: se }, { status: 500 });
    }
}