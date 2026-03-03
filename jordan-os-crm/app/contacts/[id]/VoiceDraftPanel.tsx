"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";

type Props = { contactId: string };

type Intent =
    | "check_in"
    | "follow_up"
    | "scheduling"
    | "referral_ask"
    | "review_ask"
    | "deal_update"
    | "vendor_coordination"
    | "other";

function intentLabel(i: Intent) {
    switch (i) {
        case "check_in":
            return "Check-in";
        case "follow_up":
            return "Follow-up";
        case "scheduling":
            return "Scheduling";
        case "deal_update":
            return "Deal update";
        case "vendor_coordination":
            return "Vendor coordination";
        case "referral_ask":
            return "Referral ask";
        case "review_ask":
            return "Review ask";
        default:
            return "Other";
    }
}

export default function VoiceDraftPanel({ contactId }: Props) {
    const [uid, setUid] = useState<string | null>(null);

    // Primary controls
    const [channel, setChannel] = useState<"text" | "email">("text");
    const [intent, setIntent] = useState<Intent>("check_in");
    const [length, setLength] = useState<"short" | "medium" | "long">("short");

    // Input
    const [ask, setAsk] = useState("");
    const [kp, setKp] = useState("");

    // Advanced toggles
    const [includeQuestion, setIncludeQuestion] = useState(true);
    const [includeSignature, setIncludeSignature] = useState(false);

    // AI suggestion (optional, only if you have /api/voice/suggest-intent)
    const [suggestBusy, setSuggestBusy] = useState(false);
    const [suggestErr, setSuggestErr] = useState<string | null>(null);
    const [suggestMeta, setSuggestMeta] = useState<{ intent: Intent; confidence: number; reason: string } | null>(null);

    // Draft
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        supabase.auth.getSession().then(({ data }) => {
            const user = data.session?.user ?? null;
            if (!user) {
                window.location.href = "/login";
                return;
            }
            setUid(user.id);
        });
    }, []);

    const keyPoints = useMemo(() => {
        return kp
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 12);
    }, [kp]);

    // Light “auto-suggest” intent when ask changes (debounced)
    useEffect(() => {
        let t: any = null;

        async function run() {
            if (!uid || !contactId) return;
            const text = ask.trim();
            if (text.length < 10) {
                setSuggestMeta(null);
                setSuggestErr(null);
                return;
            }

            setSuggestBusy(true);
            setSuggestErr(null);

            try {
                const res = await fetch("/api/voice/suggest-intent", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        uid,
                        contact_id: contactId,
                        channel,
                        ask: text,
                        key_points: keyPoints.length ? keyPoints : null,
                    }),
                });

                const j = await res.json();
                if (!res.ok) {
                    setSuggestErr(j?.error || "Couldn’t suggest intent");
                    setSuggestMeta(null);
                    return;
                }

                const nextIntent = (j?.intent || "other") as Intent;
                const conf = typeof j?.confidence === "number" ? j.confidence : 0.55;

                setSuggestMeta({
                    intent: nextIntent,
                    confidence: conf,
                    reason: String(j?.reason || ""),
                });

                // Auto-apply if high confidence
                if (conf >= 0.82) setIntent(nextIntent);
            } catch (e: any) {
                setSuggestErr(e?.message || "Couldn’t suggest intent");
                setSuggestMeta(null);
            } finally {
                setSuggestBusy(false);
            }
        }

        t = setTimeout(run, 350);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ask, uid, contactId, channel]);

    async function generate() {
        setErr(null);
        setCopied(false);

        if (!uid) return setErr("Not signed in.");
        if (!contactId) return setErr("Missing contact.");
        if (!ask.trim() && keyPoints.length === 0) return setErr("Add a quick prompt or a couple key points.");

        setBusy(true);
        try {
            const res = await fetch("/api/voice/draft", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    uid,
                    contact_id: contactId,
                    channel,
                    intent,
                    length,
                    ask: ask.trim() || null,
                    key_points: keyPoints.length ? keyPoints : null,
                    include_question: includeQuestion,
                    include_signature: includeSignature || channel === "email",
                }),
            });

            const j = await res.json();
            if (!res.ok) {
                setErr(j?.error || "Draft failed");
            } else {
                setDraft(j?.draft || "");
            }
        } catch (e: any) {
            setErr(e?.message || "Draft failed");
        } finally {
            setBusy(false);
        }
    }

    async function copy() {
        if (!draft) return;
        await navigator.clipboard.writeText(draft);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
    }

    return (
        <div className="section" style={{ marginTop: 18 }}>
            <div className="sectionTitleRow">
                <div className="sectionTitle">Jordan Voice</div>
                <div className="sectionSub">
                    Drafts a message in your tone using contact context + recent touches + imported texts.
                </div>
            </div>

            {(err || suggestErr) ? <div className="alert alertError">{err || suggestErr}</div> : null}

            <div className="card cardPad stack">
                {/* Top bar */}
                <div className="rowResponsiveBetween">
                    <div className="rowResponsive" style={{ gap: 12 }}>
                        {/* Channel segmented */}
                        <div className="field">
                            <div className="label">Channel</div>
                            <div className="seg" aria-label="Channel">
                                <button
                                    className={`segBtn ${channel === "text" ? "segBtnActive" : ""}`}
                                    onClick={() => setChannel("text")}
                                    type="button"
                                >
                                    Text
                                </button>
                                <button
                                    className={`segBtn ${channel === "email" ? "segBtnActive" : ""}`}
                                    onClick={() => setChannel("email")}
                                    type="button"
                                >
                                    Email
                                </button>
                            </div>
                        </div>

                        {/* Intent */}
                        <div className="field" style={{ minWidth: 220 }}>
                            <div className="label">Intent</div>
                            <select className="select" value={intent} onChange={(e) => setIntent(e.target.value as any)}>
                                <option value="check_in">Check-in</option>
                                <option value="follow_up">Follow-up</option>
                                <option value="scheduling">Scheduling</option>
                                <option value="deal_update">Deal update</option>
                                <option value="vendor_coordination">Vendor coordination</option>
                                <option value="referral_ask">Referral ask</option>
                                <option value="review_ask">Review ask</option>
                                <option value="other">Other</option>
                            </select>
                        </div>

                        {/* Length segmented */}
                        <div className="field">
                            <div className="label">Length</div>
                            <div className="seg" aria-label="Length">
                                <button
                                    className={`segBtn ${length === "short" ? "segBtnActive" : ""}`}
                                    onClick={() => setLength("short")}
                                    type="button"
                                >
                                    Short
                                </button>
                                <button
                                    className={`segBtn ${length === "medium" ? "segBtnActive" : ""}`}
                                    onClick={() => setLength("medium")}
                                    type="button"
                                >
                                    Medium
                                </button>
                                <button
                                    className={`segBtn ${length === "long" ? "segBtnActive" : ""}`}
                                    onClick={() => setLength("long")}
                                    type="button"
                                >
                                    Long
                                </button>
                            </div>
                        </div>
                    </div>

                    <button className="btn btnPrimary btnFullMobile" onClick={generate} disabled={busy}>
                        {busy ? "Writing…" : "Generate"}
                    </button>
                </div>

                {/* Ask */}
                <div className="field">
                    <div className="label">What do you want to say?</div>
                    <input
                        className="input"
                        value={ask}
                        onChange={(e) => setAsk(e.target.value)}
                        placeholder='Example: "Check in on the dishwasher decision + see how the house is going."'
                    />
                </div>

                {/* Suggestion line */}
                <div className="rowResponsiveBetween" style={{ marginTop: -2 }}>
                    <div className="muted small" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                        <span className="kicker">Suggested</span>
                        {suggestBusy ? (
                            <span>Thinking…</span>
                        ) : suggestMeta ? (
                            <>
                                <span style={{ fontWeight: 900, color: "var(--ink)" }}>
                                    {intentLabel(suggestMeta.intent)}
                                </span>
                                <span className="muted">
                                    ({Math.round(suggestMeta.confidence * 100)}%)
                                </span>
                                {suggestMeta.reason ? <span className="muted">• {suggestMeta.reason}</span> : null}
                            </>
                        ) : (
                            <span>Type a bit more to get an automatic intent suggestion.</span>
                        )}
                    </div>

                    {suggestMeta ? (
                        <button
                            className="btn btnFullMobile"
                            type="button"
                            onClick={() => setIntent(suggestMeta.intent)}
                            disabled={busy}
                        >
                            Apply suggestion
                        </button>
                    ) : null}
                </div>

                {/* Advanced */}
                <details className="details" style={{ marginTop: 2 }}>
                    <summary className="detailsSummary">
                        <span>Advanced</span>
                        <span className="detailsHint">key points • toggles</span>
                    </summary>

                    <div className="stack" style={{ marginTop: 12 }}>
                        <div className="field">
                            <div className="label">Key points (one per line)</div>
                            <textarea
                                className="textarea"
                                value={kp}
                                onChange={(e) => setKp(e.target.value)}
                                placeholder={"Keep it light\nAsk one clear question\nOffer to send the certified pre-owned outlet link"}
                            />
                            <div className="muted small" style={{ marginTop: 6 }}>
                                Tip: 2–4 lines max usually works best.
                            </div>
                        </div>

                        <div className="rowResponsive" style={{ gap: 10 }}>
                            <label className="rowResponsive" style={{ gap: 8 }}>
                                <input
                                    type="checkbox"
                                    checked={includeQuestion}
                                    onChange={(e) => setIncludeQuestion(e.target.checked)}
                                />
                                <span className="muted" style={{ fontWeight: 800 }}>
                                    Include one clear question
                                </span>
                            </label>

                            <label className="rowResponsive" style={{ gap: 8 }}>
                                <input
                                    type="checkbox"
                                    checked={includeSignature || channel === "email"}
                                    onChange={(e) => setIncludeSignature(e.target.checked)}
                                    disabled={channel === "email"}
                                />
                                <span className="muted" style={{ fontWeight: 800 }}>
                                    Include signature (Jordan)
                                </span>
                            </label>
                        </div>
                    </div>
                </details>

                {/* Draft */}
                {draft ? (
                    <div className="preview">
                        <div className="previewHeader">
                            <div className="previewTitle">Draft</div>
                            <div className="rowResponsive" style={{ gap: 8 }}>
                                <button className="btn btnFullMobile" onClick={copy} type="button">
                                    {copied ? "Copied" : "Copy"}
                                </button>
                            </div>
                        </div>

                        <div className="previewBody">{draft}</div>
                    </div>
                ) : (
                    <div className="muted small" style={{ marginTop: 4 }}>
                        Draft will appear here after you generate.
                    </div>
                )}
            </div>
        </div>
    );
}