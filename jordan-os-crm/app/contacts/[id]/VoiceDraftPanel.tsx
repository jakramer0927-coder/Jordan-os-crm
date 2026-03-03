"use client";

import { useEffect, useState } from "react";
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

export default function VoiceDraftPanel({ contactId }: Props) {
    const [uid, setUid] = useState<string | null>(null);

    const [channel, setChannel] = useState<"text" | "email">("text");
    const [intent, setIntent] = useState<Intent>("check_in");
    const [length, setLength] = useState<"short" | "medium" | "long">("short");

    const [ask, setAsk] = useState("");
    const [kp, setKp] = useState("");

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

    async function generate() {
        setErr(null);
        setCopied(false);

        if (!uid) return setErr("Not signed in.");
        if (!contactId) return setErr("Missing contact.");
        if (!ask.trim() && !kp.trim()) return setErr("Give me a quick prompt (ask and/or key points).");

        setBusy(true);
        try {
            const key_points = kp
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean);

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
                    key_points: key_points.length ? key_points : null,
                    include_question: true,
                    include_signature: channel === "email",
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
                <div className="sectionSub">Generates a draft using your emails + texts for tone.</div>
            </div>

            {err ? <div className="alert alertError">{err}</div> : null}

            <div className="card cardPad stack">
                <div className="rowResponsiveBetween">
                    <div className="rowResponsive">
                        <div className="field" style={{ width: 160 }}>
                            <div className="label">Channel</div>
                            <select className="select" value={channel} onChange={(e) => setChannel(e.target.value as any)}>
                                <option value="text">text</option>
                                <option value="email">email</option>
                            </select>
                        </div>

                        <div className="field" style={{ width: 220 }}>
                            <div className="label">Intent</div>
                            <select className="select" value={intent} onChange={(e) => setIntent(e.target.value as any)}>
                                <option value="check_in">check_in</option>
                                <option value="follow_up">follow_up</option>
                                <option value="scheduling">scheduling</option>
                                <option value="deal_update">deal_update</option>
                                <option value="vendor_coordination">vendor_coordination</option>
                                <option value="referral_ask">referral_ask</option>
                                <option value="review_ask">review_ask</option>
                                <option value="other">other</option>
                            </select>
                        </div>

                        <div className="field" style={{ width: 160 }}>
                            <div className="label">Length</div>
                            <select className="select" value={length} onChange={(e) => setLength(e.target.value as any)}>
                                <option value="short">short</option>
                                <option value="medium">medium</option>
                                <option value="long">long</option>
                            </select>
                        </div>
                    </div>

                    <button className="btn btnPrimary btnFullMobile" onClick={generate} disabled={busy}>
                        {busy ? "Writing…" : "Generate"}
                    </button>
                </div>

                <div className="field">
                    <div className="label">What do you want to say?</div>
                    <input
                        className="input"
                        value={ask}
                        onChange={(e) => setAsk(e.target.value)}
                        placeholder='Example: "Check in on dishwasher decision + see how the house is going."'
                    />
                </div>

                <div className="field">
                    <div className="label">Key points (one per line)</div>
                    <textarea
                        className="textarea"
                        value={kp}
                        onChange={(e) => setKp(e.target.value)}
                        placeholder={"- keep it light\n- ask one clear question\n- offer to send the certified pre-owned outlet link"}
                    />
                </div>

                {draft ? (
                    <div className="card cardPad" style={{ background: "rgba(247,244,238,.45)" }}>
                        <div className="rowBetween">
                            <div style={{ fontWeight: 900 }}>Draft</div>
                            <button className="btn btnFullMobile" onClick={copy}>
                                {copied ? "Copied" : "Copy"}
                            </button>
                        </div>
                        <div style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>{draft}</div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}