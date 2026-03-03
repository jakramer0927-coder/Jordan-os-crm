"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import VoiceDraftPanel from "./VoiceDraftPanel";

type TouchIntent =
  | "check_in"
  | "referral_ask"
  | "review_ask"
  | "deal_followup"
  | "collaboration"
  | "event_invite"
  | "other";

type Contact = {
  id: string;
  display_name: string;
  category: string;
  tier: string | null;
  client_type: string | null;
  created_at: string;
};

type Touch = {
  id: string;
  contact_id: string;
  channel: "email" | "text" | "call" | "in_person" | "social_dm" | "other";
  direction: "outbound" | "inbound";
  occurred_at: string;
  intent: TouchIntent | null;
  summary: string | null;
  source: string | null;
  source_link: string | null;
};

function prettyCategory(c: string) {
  const s = (c || "").trim();
  if (!s) return "Other";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function TextThreadUploadPanel({ contactId }: { contactId: string }) {
  const [uid, setUid] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

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

  async function upload() {
    setErr(null);
    setMsg(null);

    if (!uid) return setErr("Not signed in.");
    if (!raw.trim() || raw.trim().length < 20) return setErr("Paste a longer text thread.");
    setBusy(true);

    try {
      const res = await fetch("/api/text/imessage/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uid,
          contact_id: contactId,
          title: title.trim() || null,
          raw_text: raw,
        }),
      });

      const j = await res.json();

      if (!res.ok) {
        setErr(j?.error || "Import failed");
      } else {
        setMsg(`Imported thread ✅ Messages inserted: ${j.inserted_messages ?? "?"}`);
        setTitle("");
        setRaw("");
      }
    } catch (e: any) {
      setErr(e?.message || "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="section" style={{ marginTop: 18 }}>
      <div className="sectionTitleRow">
        <div className="sectionTitle">Upload text thread</div>
        <div className="sectionSub">
          Paste iMessage thread text → attach to this contact → used for notes + better drafts.
        </div>
      </div>

      {(err || msg) && (
        <div className="card cardPad" style={{ borderColor: err ? "rgba(160,0,0,0.25)" : undefined }}>
          <div style={{ fontWeight: 900, color: err ? "#8a0000" : "#0b6b2a", whiteSpace: "pre-wrap" }}>
            {err || msg}
          </div>
        </div>
      )}

      <div className="card cardPad">
        <div className="rowResponsive" style={{ gap: 10 }}>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder='Optional title (e.g., "Feb 2026 — renovation planning")'
            style={{ flex: 1, minWidth: 260 }}
          />
          <button className="btn btnPrimary btnFullMobile" onClick={upload} disabled={busy}>
            {busy ? "Importing…" : "Import"}
          </button>
        </div>

        <div style={{ marginTop: 10 }}>
          <textarea
            className="textarea"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            placeholder={`Paste an iMessage thread here.\n\nExample:\nJordan: Hey — quick check-in...\nRay: All good...`}
            style={{ minHeight: 220 }}
          />
        </div>

        <div className="muted small" style={{ marginTop: 10 }}>
          Tip: iPhone → Messages → open thread → select text → copy → paste here. Even if parsing isn’t perfect, the raw
          thread is saved.
        </div>
      </div>
    </div>
  );
}

export default function ContactDetailPage() {
  const params = useParams();
  const id = (params?.id as string) || "";

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [contact, setContact] = useState<Contact | null>(null);
  const [touches, setTouches] = useState<Touch[]>([]);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Client");
  const [tier, setTier] = useState<"A" | "B" | "C">("A");
  const [clientType, setClientType] = useState("");
  const [savingContact, setSavingContact] = useState(false);

  const [logOpen, setLogOpen] = useState(false);
  const [logChannel, setLogChannel] = useState<Touch["channel"]>("text");
  const [logDirection, setLogDirection] = useState<Touch["direction"]>("outbound");
  const [logIntent, setLogIntent] = useState<TouchIntent>("check_in");
  const [logOccurredAt, setLogOccurredAt] = useState<string>("");
  const [logSummary, setLogSummary] = useState("");
  const [logSource, setLogSource] = useState("manual");
  const [logLink, setLogLink] = useState("");
  const [savingTouch, setSavingTouch] = useState(false);

  const [deleting, setDeleting] = useState(false);

  const lastOutbound = useMemo(() => {
    const t = touches.find((x) => x.direction === "outbound");
    return t ? new Date(t.occurred_at) : null;
  }, [touches]);

  async function requireSession() {
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      window.location.href = "/login";
      return null;
    }
    return data.session;
  }

  async function fetchAll() {
    setError(null);

    const sess = await requireSession();
    if (!sess) return;

    const { data: cData, error: cErr } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, client_type, created_at")
      .eq("id", id)
      .single();

    if (cErr) {
      setError(`Contact fetch error: ${cErr.message}`);
      setContact(null);
      setTouches([]);
      return;
    }

    const c = cData as Contact;
    setContact(c);

    setName(c.display_name || "");
    setCategory(c.category || "Client");
    setTier(((c.tier || "A").toUpperCase() as any) || "A");
    setClientType(c.client_type || "");

    const { data: tData, error: tErr } = await supabase
      .from("touches")
      .select("id, contact_id, channel, direction, occurred_at, intent, summary, source, source_link")
      .eq("contact_id", id)
      .order("occurred_at", { ascending: false })
      .limit(500);

    if (tErr) {
      setError((prev) => prev ?? `Touches fetch error: ${tErr.message}`);
      setTouches([]);
      return;
    }

    setTouches((tData ?? []) as Touch[]);
  }

  async function saveContact() {
    if (!contact) return;
    setSavingContact(true);
    setError(null);

    const { error } = await supabase
      .from("contacts")
      .update({
        display_name: name.trim(),
        category,
        tier,
        client_type: clientType.trim() ? clientType.trim() : null,
      })
      .eq("id", contact.id);

    setSavingContact(false);

    if (error) {
      setError(`Update contact error: ${error.message}`);
      return;
    }

    setEditing(false);
    await fetchAll();
  }

  function openLog() {
    setLogOpen(true);
    setLogChannel("text");
    setLogDirection("outbound");
    setLogIntent("check_in");
    setLogSummary("");
    setLogSource("manual");
    setLogLink("");
    setLogOccurredAt(new Date().toISOString().slice(0, 16)); // yyyy-mm-ddThh:mm
  }

  async function saveTouch() {
    if (!contact) return;
    setSavingTouch(true);
    setError(null);

    const occurred_at = logOccurredAt ? new Date(logOccurredAt).toISOString() : new Date().toISOString();

    const { error } = await supabase.from("touches").insert({
      contact_id: contact.id,
      channel: logChannel,
      direction: logDirection,
      intent: logIntent,
      occurred_at,
      summary: logSummary.trim() ? logSummary.trim() : null,
      source: logSource.trim() ? logSource.trim() : null,
      source_link: logLink.trim() ? logLink.trim() : null,
    });

    setSavingTouch(false);

    if (error) {
      setError(`Insert touch error: ${error.message}`);
      return;
    }

    setLogOpen(false);
    await fetchAll();
  }

  async function deleteContact() {
    if (!contact) return;

    const ok = window.confirm(`Delete contact "${contact.display_name}"? This cannot be undone.`);
    if (!ok) return;

    setDeleting(true);
    setError(null);

    const { data } = await supabase.auth.getSession();
    const uid = data.session?.user.id ?? null;

    if (!uid) {
      window.location.href = "/login";
      return;
    }

    const res = await fetch("/api/contacts/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, contact_id: contact.id }),
    });

    const j = await res.json();
    setDeleting(false);

    if (!res.ok) {
      setError(j?.error || "Delete failed");
      return;
    }

    window.location.href = "/contacts";
  }

  useEffect(() => {
    let alive = true;

    const init = async () => {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user.id ?? null;

      if (!alive) return;

      if (!uid) {
        setTimeout(async () => {
          const { data: d2 } = await supabase.auth.getSession();
          if (!d2.session) window.location.href = "/login";
        }, 250);
        return;
      }

      setReady(true);
      await fetchAll();
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const uid = session?.user.id ?? null;
      if (!uid) window.location.href = "/login";
    });

    init();

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!ready) return <div className="card cardPad">Loading…</div>;

  if (!contact) {
    return (
      <div className="stack">
        <div className="card cardPad">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Contact not found</div>
          {error ? (
            <div className="alert alertError" style={{ marginTop: 10 }}>
              {error}
            </div>
          ) : null}
          <div style={{ marginTop: 12 }}>
            <a href="/contacts">← Back to Contacts</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="rowResponsiveBetween">
        <div style={{ minWidth: 0 }}>
          <div className="rowResponsive" style={{ alignItems: "baseline" }}>
            <h1 className="h1" style={{ margin: 0 }}>
              {contact.display_name}
            </h1>
            <span className="subtle">
              {prettyCategory(contact.category)} {contact.tier ? `• Tier ${contact.tier}` : ""}{" "}
              {contact.client_type ? `• ${contact.client_type}` : ""}
            </span>
          </div>

          <div className="subtle" style={{ marginTop: 8, fontSize: 13 }}>
            Last outbound: <strong>{lastOutbound ? lastOutbound.toLocaleString() : "—"}</strong>
          </div>
        </div>

        <div className="rowResponsive" style={{ justifyContent: "flex-end" }}>
          <a className="btn btnFullMobile" href="/contacts" style={{ textDecoration: "none" }}>
            Contacts
          </a>
          <button className="btn btnFullMobile" onClick={() => setEditing((v) => !v)}>
            {editing ? "Close edit" : "Edit"}
          </button>
          <button className="btn btnFullMobile" onClick={deleteContact} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete"}
          </button>
          <button className="btn btnPrimary btnFullMobile" onClick={openLog}>
            Log touch
          </button>
        </div>
      </div>

      {error ? <div className="alert alertError">{error}</div> : null}

      {editing && (
        <div className="card cardPad stack">
          <div style={{ fontWeight: 900, fontSize: 16 }}>Edit contact</div>

          <div className="fieldGridMobile" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ flex: 1, minWidth: 240 }}>
              <div className="label">Name</div>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="field" style={{ width: 220, minWidth: 180 }}>
              <div className="label">Category</div>
              <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option>Client</option>
                <option>Agent</option>
                <option>Developer</option>
                <option>Vendor</option>
                <option>Other</option>
              </select>
            </div>

            <div className="field" style={{ width: 140 }}>
              <div className="label">Tier</div>
              <select className="select" value={tier} onChange={(e) => setTier(e.target.value as any)}>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
              </select>
            </div>
          </div>

          <div className="field">
            <div className="label">Client Type (optional)</div>
            <input
              className="input"
              value={clientType}
              onChange={(e) => setClientType(e.target.value)}
              placeholder="buyer / seller / past_client / lead / landlord / tenant / sphere ..."
            />
          </div>

          <div className="rowResponsive">
            <button className="btn btnPrimary btnFullMobile" onClick={saveContact} disabled={savingContact}>
              {savingContact ? "Saving…" : "Save"}
            </button>
            <button className="btn btnFullMobile" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Jordan Voice FIRST */}
      <VoiceDraftPanel contactId={contact.id} />

      {/* Text upload NEXT */}
      <TextThreadUploadPanel contactId={contact.id} />

      <div className="card cardPad stack">
        <div style={{ fontWeight: 900, fontSize: 16 }}>Touch history</div>

        {touches.length === 0 ? (
          <div className="subtle">No touches yet.</div>
        ) : (
          <div className="stack">
            {touches.map((t) => (
              <div key={t.id} className="card cardPad">
                <div className="rowResponsiveBetween">
                  <div style={{ fontWeight: 900 }}>
                    {t.direction.toUpperCase()} • {t.channel}
                    {t.intent ? <span className="subtle"> • {t.intent}</span> : null}
                  </div>
                  <div className="subtle">{new Date(t.occurred_at).toLocaleString()}</div>
                </div>

                {t.summary ? <div style={{ marginTop: 10, whiteSpace: "pre-wrap" }}>{t.summary}</div> : null}

                <div className="subtle" style={{ marginTop: 10, fontSize: 12 }}>
                  {t.source ? `source: ${t.source}` : ""}
                  {t.source_link ? (
                    <>
                      {" "}
                      •{" "}
                      <a href={t.source_link} target="_blank" rel="noreferrer">
                        open link
                      </a>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {logOpen && (
        <div
          className="modalSheet"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            padding: 16,
            zIndex: 999,
          }}
        >
          <div className="card cardPad modalSheetCard" style={{ width: "min(860px, 100%)" }}>
            <div className="rowResponsiveBetween">
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Log touch</div>
                <div className="subtle" style={{ marginTop: 4 }}>
                  {contact.display_name}
                </div>
              </div>
              <button className="btn btnFullMobile" onClick={() => setLogOpen(false)}>
                Close
              </button>
            </div>

            <div className="rowResponsive" style={{ marginTop: 12, alignItems: "flex-end" }}>
              <div className="field" style={{ width: 160, minWidth: 160 }}>
                <div className="label">Direction</div>
                <select className="select" value={logDirection} onChange={(e) => setLogDirection(e.target.value as any)}>
                  <option value="outbound">outbound</option>
                  <option value="inbound">inbound</option>
                </select>
              </div>

              <div className="field" style={{ width: 160, minWidth: 160 }}>
                <div className="label">Channel</div>
                <select className="select" value={logChannel} onChange={(e) => setLogChannel(e.target.value as any)}>
                  <option value="email">email</option>
                  <option value="text">text</option>
                  <option value="call">call</option>
                  <option value="in_person">in_person</option>
                  <option value="social_dm">social_dm</option>
                  <option value="other">other</option>
                </select>
              </div>

              <div className="field" style={{ width: 220, minWidth: 220 }}>
                <div className="label">Intent</div>
                <select className="select" value={logIntent} onChange={(e) => setLogIntent(e.target.value as any)}>
                  <option value="check_in">check_in</option>
                  <option value="referral_ask">referral_ask</option>
                  <option value="review_ask">review_ask</option>
                  <option value="deal_followup">deal_followup</option>
                  <option value="collaboration">collaboration</option>
                  <option value="event_invite">event_invite</option>
                  <option value="other">other</option>
                </select>
              </div>

              <div className="field" style={{ width: 220, minWidth: 220 }}>
                <div className="label">Occurred at</div>
                <input
                  className="input"
                  type="datetime-local"
                  value={logOccurredAt}
                  onChange={(e) => setLogOccurredAt(e.target.value)}
                />
              </div>

              <div className="field" style={{ flex: 1, minWidth: 220 }}>
                <div className="label">Source</div>
                <input
                  className="input"
                  value={logSource}
                  onChange={(e) => setLogSource(e.target.value)}
                  placeholder="manual / gmail / sms"
                />
              </div>

              <div className="field" style={{ flex: 1, minWidth: 260 }}>
                <div className="label">Link (optional)</div>
                <input
                  className="input"
                  value={logLink}
                  onChange={(e) => setLogLink(e.target.value)}
                  placeholder="thread link / calendar link"
                />
              </div>
            </div>

            <div className="field" style={{ marginTop: 10 }}>
              <div className="label">Summary (optional)</div>
              <textarea
                className="textarea"
                value={logSummary}
                onChange={(e) => setLogSummary(e.target.value)}
                placeholder="Quick note about what happened"
              />
            </div>

            <div className="rowResponsive" style={{ marginTop: 12 }}>
              <button className="btn btnPrimary btnFullMobile" onClick={saveTouch} disabled={savingTouch}>
                {savingTouch ? "Saving…" : "Save touch"}
              </button>
              <button className="btn btnFullMobile" onClick={() => setLogOpen(false)}>
                Cancel
              </button>
            </div>

            <div className="subtle" style={{ marginTop: 10, fontSize: 12 }}>
              Note: outbound resets cadence. inbound is tracked but doesn’t reset cadence.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}