// app/api/voice/draft/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function safeErr(e: unknown) {
    const anyE = e as { message?: unknown; name?: unknown; stack?: unknown };
    return {
        message: String(anyE?.message || e || "Unknown error"),
        name: String(anyE?.name || ""),
        stack: typeof anyE?.stack === "string" ? anyE.stack.split("\n").slice(0, 12).join("\n") : "",
    };
}

type Body = {
    uid: string;
    contact_id: string;

    // what you want to send
    channel: "text" | "email";
    intent:
    | "check_in"
    | "follow_up"
    | "scheduling"
    | "referral_ask"
    | "review_ask"
    | "deal_update"
    | "vendor_coordination"
    | "other";

    // details for the draft
    ask?: string | null; // e.g. "ask if they decided on the dishwasher"
    key_points?: string[] | null;

    // constraints
    length?: "short" | "medium" | "long";
    include_question?: boolean; // default true
    include_signature?: boolean; // default false for text, true-ish for email
};

async function openaiDraft(args: {
    system: string;
    user: string;
    model?: string;
}): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

    const model = args.model || process.env.OPENAI_MODEL || "gpt-4o-mini";

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: "system", content: args.system },
                { role: "user", content: args.user },
            ],
            temperature: 0.5,
        }),
    });

    const j = await res.json();

    if (!res.ok) {
        const msg = j?.error?.message || `OpenAI error (${res.status})`;
        throw new Error(msg);
    }

    const text = j?.choices?.[0]?.message?.content;
    if (typeof text === "string" && text.trim()) return text.trim();

    throw new Error("OpenAI returned no text");
}

export async function POST(req: Request) {
    try {
        const body = (await req.json()) as Body;

        const uid = body?.uid || "";
        const contactId = body?.contact_id || "";
        const channel = body?.channel || "text";
        const intent = body?.intent || "other";

        const ask = (body?.ask || "").trim();
        const keyPoints = (body?.key_points || []).filter(Boolean).map((s) => String(s).trim()).filter(Boolean);

        const length = body?.length || "short";
        const includeQuestion = body?.include_question ?? true;
        const includeSignature = body?.include_signature ?? (channel === "email");

        if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
        if (!isUuid(contactId)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 });

        // 1) Contact
        const { data: contact, error: cErr } = await supabaseAdmin
            .from("contacts")
            .select("id, user_id, display_name, category, tier, client_type, notes, company, email, phone")
            .eq("id", contactId)
            .eq("user_id", uid)
            .single();

        if (cErr || !contact) {
            return NextResponse.json({ error: cErr?.message || "Contact not found" }, { status: 404 });
        }

        // 2) Recent touches
        const { data: touches, error: tErr } = await supabaseAdmin
            .from("touches")
            .select("direction, channel, occurred_at, intent, summary")
            .eq("contact_id", contactId)
            .order("occurred_at", { ascending: false })
            .limit(25);

        if (tErr) {
            return NextResponse.json({ error: tErr.message }, { status: 500 });
        }

        // 3) Recent text messages (if you have them)
        const { data: texts } = await supabaseAdmin
            .from("text_messages")
            .select("direction, occurred_at, body")
            .eq("contact_id", contactId)
            .eq("user_id", uid)
            .order("created_at", { ascending: false })
            .limit(40);

        // 4) Voice examples
        const { data: examples, error: vErr } = await supabaseAdmin
            .from("user_voice_examples")
            .select("channel, intent, text, subject, snippet, body_preview, occurred_at, created_at")
            .eq("user_id", uid)
            .order("occurred_at", { ascending: false })
            .limit(60);

        if (vErr) {
            return NextResponse.json({ error: vErr.message }, { status: 500 });
        }

        const voiceExamples = (examples ?? [])
            .map((x: any) => {
                const txt =
                    (x?.text as string) ||
                    [x?.subject, x?.snippet, x?.body_preview].filter(Boolean).join("\n").trim();
                if (!txt) return null;
                return {
                    channel: x?.channel || "email",
                    intent: x?.intent || null,
                    text: txt,
                };
            })
            .filter(Boolean);

        // Keep it tight: best 20 examples max
        const voiceSample = voiceExamples.slice(0, 20);

        const contactSummary = {
            name: contact.display_name,
            category: contact.category,
            tier: contact.tier,
            client_type: contact.client_type,
            company: contact.company,
            notes: contact.notes,
        };

        const recentTouchSummary = (touches ?? []).slice(0, 12).map((x: any) => ({
            direction: x.direction,
            channel: x.channel,
            occurred_at: x.occurred_at,
            intent: x.intent,
            summary: x.summary,
        }));

        const recentTextSummary = (texts ?? []).slice(0, 12).map((m: any) => ({
            direction: m.direction,
            occurred_at: m.occurred_at,
            body: m.body,
        }));

        const lengthRule =
            length === "short"
                ? "Keep it very short (1–3 sentences for text; 3–6 for email)."
                : length === "medium"
                    ? "Keep it medium (3–6 sentences for text; 6–12 for email)."
                    : "It can be longer, but still crisp and skimmable.";

        const system = [
            "You write outbound client, agent, and vendor messages in Jordan Kramer’s style.",
            "Jordan is a luxury Los Angeles real estate advisor.",
            "His tone: warm, calm, confident, intelligent, concise, modern.",
            "Never overly salesy. Never hype-y. No exclamation spam.",
            "For TEXT: conversational, tight, 1-4 sentences max.",
            "For EMAIL: structured, crisp, skimmable, polished.",
            "Jordan’s style: warm, direct, confident, low-fluff, helpful, modern, no salesy language, no exclamation spam.",
            "Use natural contractions. Avoid corporate buzzwords. Avoid emojis unless it truly fits (default: none).",
            "Never invent facts. Use only provided context.",
            "Output ONLY the final message body. No preamble, no bullet labels, no quotes.",
        ].join(" ");

        const user = [
            `TASK: Draft a ${channel.toUpperCase()} message.`,
            `Intent: ${intent}`,
            `Intent guidance:`,
            intent === "check_in"
                ? "- Warm relationship touchpoint. Light. No pressure."
                : intent === "follow_up"
                    ? "- Follow up on something previously discussed."
                    : intent === "scheduling"
                        ? "- Coordinate time/date. Be clear and concise."
                        : intent === "deal_update"
                            ? "- Provide update related to a transaction or home process."
                            : intent === "vendor_coordination"
                                ? "- Coordinate logistics with contractor/vendor."
                                : intent === "referral_ask"
                                    ? "- Soft referral positioning. Never pushy."
                                    : intent === "review_ask"
                                        ? "- Ask for a review politely and briefly."
                                        : "- General purpose communication.",
            "",
            "CONSTRAINTS:",
            `- ${lengthRule}`,
            `- ${includeQuestion ? "Include one clear question if helpful." : "Do not include a question unless absolutely necessary."}`,
            `- ${includeSignature ? "Include a simple signature ('Jordan')." : "No signature."}`,
            "",
            "CONTACT CONTEXT:",
            JSON.stringify(contactSummary, null, 2),
            "",
            "RECENT TOUCHES (most recent first):",
            JSON.stringify(recentTouchSummary, null, 2),
            "",
            "RECENT TEXT THREAD SNIPPETS (most recent first):",
            JSON.stringify(recentTextSummary, null, 2),
            "",
            "WHAT I WANT TO SAY (from Jordan):",
            ask ? `Ask: ${ask}` : "",
            keyPoints.length ? `Key points:\n- ${keyPoints.join("\n- ")}` : "",
            "",
            "VOICE EXAMPLES (Jordan’s past writing):",
            voiceSample
                .map((e: any, i: number) => `Example ${i + 1} (${e.channel}${e.intent ? `, ${e.intent}` : ""}):\n${e.text}`)
                .join("\n\n---\n\n"),
        ]
            .filter(Boolean)
            .join("\n");

        const draft = await openaiDraft({ system, user });

        return NextResponse.json({
            ok: true,
            contact_id: contactId,
            channel,
            intent,
            draft,
            used_examples: voiceSample.length,
        });
    } catch (e) {
        const se = safeErr(e);
        console.error("VOICE_DRAFT_CRASH", se);
        return NextResponse.json({ error: "Voice draft crashed", details: se }, { status: 500 });
    }
}