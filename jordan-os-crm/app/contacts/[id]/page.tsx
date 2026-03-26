"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();
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
  notes: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  created_at: string;
  user_id?: string;
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


function channelLabel(c: Touch["channel"]) {
  switch (c) {
    case "email": return "Email";
    case "text": return "Text";
    case "call": return "Call";
    case "in_person": return "In person";
    case "social_dm": return "Social DM";
    default: return "Other";
  }
}

function intentLabel(i: string | null) {
  switch (i) {
    case "check_in": return "Check-in";
    case "referral_ask": return "Referral ask";
    case "review_ask": return "Review ask";
    case "deal_followup": return "Deal follow-up";
    case "collaboration": return "Collaboration";
    case "event_invite": return "Event invite";
    default: return i || "Other";
  }
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
        setMsg(`Imported ✅ Messages inserted: ${j.inserted_messages ?? "?"}`);
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
          Paste iMessage thread text → attach to this contact → improves Jordan Voice + keeps history.
        </div>
      </div>

      {(err || msg) ? (
        <div className={`alert ${err ? "alertError" : "alertOk"}`}>{err || msg}</div>
      ) : null}

      <div className="card cardPad stack">
        <div className="rowResponsiveBetween">
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder='Optional title (e.g., "Feb 2026 — renovation planning")'
            style={{ flex: 1, minWidth: 240 }}
          />
          <button className="btn btnPrimary btnFullMobile" onClick={upload} disabled={busy}>
            {busy ? "Importing…" : "Import"}
          </button>
        </div>

        <textarea
          className="textarea"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={`Paste an iMessage thread here.\n\nExample:\nJordan: Hey — quick check-in...\nAli: Yeah, Bosch has a good one...`}
          style={{ minHeight: 220 }}
        />

        <div className="muted small">
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

  const [uid, setUid] = useState<string | null>(null);

  const [contact, setContact] = useState<Contact | null>(null);
  const [touches, setTouches] = useState<Touch[]>([]);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Client");
  const [tier, setTier] = useState<"A" | "B" | "C">("A");
  const [clientType, setClientType] = useState("");
  const [notes, setNotes] = useState("");
  const [company, setCompany] = useState("");
  const [savingContact, setSavingContact] = useState(false);

  const [logOpen, setLogOpen] = useState(false);
  const [logChannel, setLogChannel] = useState<Touch["channel"]>("text");
  const [logDirection, setLogDirection] = useState<Touch["direction"]>("outbound");
  const [logIntent, setLogIntent] = useState<TouchIntent>("check_in");
  const [logOccurredAt, setLogOccurredAt] = useState<string>("");
  const [logSummary, setLogSummary] = useState("");
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

    const myUid = sess.user.id;
    setUid(myUid);

    const { data: cData, error: cErr } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, client_type, notes, company, email, phone, created_at, user_id")
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
    setNotes(c.notes || "");
    setCompany(c.company || "");

    const { data: tData, error: tErr } = await supabase
      .from("touches")
      .select("id, contact_id, channel, direction, occurred_at, intent, summary, source, source_link")
      .eq("contact_id", id)
      .order("occurred_at", { ascending: false })
      .limit(200);

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
        notes: notes.trim() ? notes.trim() : null,
        company: company.trim() ? company.trim() : null,
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
    setLogOccurredAt(new Date().toISOString().slice(0, 16));
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
      source: "manual",
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
    if (!contact || !uid) return;

    const ok = window.confirm(`Delete contact "${contact.display_name}"?\n\nThis will delete touches + imported texts too.`);
    if (!ok) return;

    setDeleting(true);
    setError(null);

    try {
      const res = await fetch("/api/contacts/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, contact_id: contact.id }),
      });

      const j = await res.json();
      if (!res.ok) {
        setError(j?.error || "Delete failed");
        setDeleting(false);
        return;
      }

      window.location.href = "/contacts";
    } catch (e: any) {
      setError(e?.message || "Delete failed");
      setDeleting(false);
    }
  }

  useEffect(() => {
    let alive = true;

    const init = async () => {
      const { data } = await supabase.auth.getSession();
      const myUid = data.session?.user.id ?? null;

      if (!alive) return;

      if (!myUid) {
        window.location.href = "/login";
        return;
      }

      setReady(true);
      await fetchAll();
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const myUid = session?.user.id ?? null;
      if (!myUid) window.location.href = "/login";
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
          {error ? <div className="alert alertError" style={{ marginTop: 10 }}>{error}</div> : null}
          <div style={{ marginTop: 12 }}>
            <a href="/contacts" style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>
              ← Back to Contacts
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {/* Header */}
      <div className="card cardPad">
        <div className="rowResponsiveBetween">
          <div style={{ minWidth: 0 }}>
            <div className="rowResponsive" style={{ alignItems: "baseline" }}>
              <h1 className="h1" style={{ margin: 0 }}>
                {contact.display_name}
              </h1>
              <span className="subtle">
                {prettyCategory(contact.category)}
                {contact.tier ? ` • Tier ${contact.tier}` : ""}
                {contact.client_type ? ` • ${contact.client_type}` : ""}
              </span>
            </div>

            {(contact.company || contact.email || contact.phone) && (
              <div className="subtle" style={{ marginTop: 6, fontSize: 13, display: "flex", gap: 12, flexWrap: "wrap" }}>
                {contact.company && <span>{contact.company}</span>}
                {contact.email && <a href={`mailto:${contact.email}`} style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>{contact.email}</a>}
                {contact.phone && <span>{contact.phone}</span>}
              </div>
            )}

            <div className="subtle" style={{ marginTop: 6, fontSize: 13 }}>
              Last outreach: <strong>{lastOutbound ? lastOutbound.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" }) : "—"}</strong>
            </div>
          </div>

          <div className="rowResponsive" style={{ justifyContent: "flex-end" }}>
            <a className="btn btnFullMobile" href="/contacts" style={{ textDecoration: "none" }}>
              Contacts
            </a>
            <button className="btn btnFullMobile" onClick={() => setEditing((v) => !v)}>
              {editing ? "Close" : "Edit"}
            </button>
            <button className="btn btnPrimary btnFullMobile" onClick={openLog}>
              Log outreach
            </button>
          </div>
        </div>

        {error ? <div className="alert alertError" style={{ marginTop: 12 }}>{error}</div> : null}
      </div>

      {/* Edit (clean, with danger zone) */}
      {editing && (
        <div className="card cardPad stack">
          <div className="rowResponsiveBetween">
            <div>
              <div style={{ fontWeight: 900, fontSize: 16 }}>Edit contact</div>
              <div className="subtle" style={{ marginTop: 4 }}>Keep it tight. No busy work.</div>
            </div>
            <button className="btn btnFullMobile" onClick={() => setEditing(false)}>
              Close
            </button>
          </div>

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

          <div className="fieldGridMobile" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <div className="label">Client type (optional)</div>
              <input
                className="input"
                value={clientType}
                onChange={(e) => setClientType(e.target.value)}
                placeholder="buyer / seller / past client / lead / sphere …"
              />
            </div>

            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <div className="label">Company (optional)</div>
              <input
                className="input"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Compass, Douglas Elliman …"
              />
            </div>
          </div>

          <div className="field">
            <div className="label">Notes</div>
            <textarea
              className="textarea"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Relationship context, key details, things to remember for future conversations…"
              style={{ minHeight: 100 }}
            />
          </div>

          <div className="rowResponsive">
            <button className="btn btnPrimary btnFullMobile" onClick={saveContact} disabled={savingContact}>
              {savingContact ? "Saving…" : "Save"}
            </button>
          </div>

          <div className="hr" />

          <div className="stack">
            <div style={{ fontWeight: 900 }}>Danger zone</div>
            <div className="subtle" style={{ fontSize: 12 }}>
              Deletes touches + imported texts attached to this contact.
            </div>
            <button className="btn btnFullMobile" onClick={deleteContact} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete contact"}
            </button>
          </div>
        </div>
      )}

      {/* Notes — always visible if present, or shows prompt to add */}
      <div className="card cardPad">
        <div className="rowResponsiveBetween" style={{ marginBottom: contact.notes ? 10 : 0 }}>
          <div style={{ fontWeight: 900 }}>Notes</div>
          {!editing && (
            <button className="btn" style={{ fontSize: 12 }} onClick={() => setEditing(true)}>
              {contact.notes ? "Edit" : "Add notes"}
            </button>
          )}
        </div>
        {contact.notes ? (
          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{contact.notes}</div>
        ) : (
          <div className="subtle">No notes yet. Use notes to capture context, deal status, key details — anything useful for the next conversation.</div>
        )}
      </div>

      {/* Touch history */}
      <details className="card cardPad" open={touches.length > 0 && touches.length <= 10}>
        <summary style={{ cursor: "pointer", fontWeight: 900, listStyle: "none" as any }}>
          Outreach history <span className="subtle">({touches.length})</span>
        </summary>

        <div className="stack" style={{ marginTop: 12 }}>
          {touches.length === 0 ? (
            <div className="subtle">No outreach logged yet.</div>
          ) : (
            touches.map((t) => (
              <div key={t.id} className="card cardPad" style={{ padding: "10px 14px" }}>
                <div className="rowResponsiveBetween">
                  <div style={{ fontWeight: 700, fontSize: 14 }}>
                    {t.direction === "outbound" ? "You reached out" : "They reached out"}
                    <span className="subtle" style={{ fontWeight: 400, marginLeft: 8 }}>
                      via {channelLabel(t.channel)}
                      {t.intent ? ` • ${intentLabel(t.intent)}` : ""}
                    </span>
                  </div>
                  <div className="subtle" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                    {new Date(t.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </div>
                </div>

                {t.summary ? (
                  <div style={{ marginTop: 6, color: "#444", fontSize: 13, whiteSpace: "pre-wrap" }}>{t.summary}</div>
                ) : null}

                {t.source_link ? (
                  <div style={{ marginTop: 4, fontSize: 12 }}>
                    <a href={t.source_link} target="_blank" rel="noreferrer" style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>
                      {t.source === "gmail" ? "View in Gmail" : "View thread"}
                    </a>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </details>

      {/* Jordan Voice */}
      <VoiceDraftPanel contactId={contact.id} />

      {/* Text upload NEXT */}
      <TextThreadUploadPanel contactId={contact.id} />

      {/* Log outreach modal */}
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
          <div className="card cardPad modalSheetCard" style={{ width: "min(680px, 100%)" }}>
            <div className="rowResponsiveBetween">
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Log outreach</div>
                <div className="subtle" style={{ marginTop: 4 }}>{contact.display_name}</div>
              </div>
              <button className="btn btnFullMobile" onClick={() => setLogOpen(false)}>
                Close
              </button>
            </div>

            <div className="rowResponsive" style={{ marginTop: 14, alignItems: "flex-end" }}>
              <div className="field" style={{ width: 180, minWidth: 160 }}>
                <div className="label">Who reached out</div>
                <select className="select" value={logDirection} onChange={(e) => setLogDirection(e.target.value as any)}>
                  <option value="outbound">I reached out</option>
                  <option value="inbound">They reached out</option>
                </select>
              </div>

              <div className="field" style={{ width: 160, minWidth: 140 }}>
                <div className="label">How</div>
                <select className="select" value={logChannel} onChange={(e) => setLogChannel(e.target.value as any)}>
                  <option value="text">Text</option>
                  <option value="email">Email</option>
                  <option value="call">Call</option>
                  <option value="in_person">In person</option>
                  <option value="social_dm">Social DM</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div className="field" style={{ width: 200, minWidth: 160 }}>
                <div className="label">Purpose</div>
                <select className="select" value={logIntent} onChange={(e) => setLogIntent(e.target.value as any)}>
                  <option value="check_in">Check-in</option>
                  <option value="follow_up">Follow-up</option>
                  <option value="deal_followup">Deal follow-up</option>
                  <option value="referral_ask">Referral ask</option>
                  <option value="review_ask">Review ask</option>
                  <option value="collaboration">Collaboration</option>
                  <option value="event_invite">Event invite</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div className="field" style={{ width: 200, minWidth: 160 }}>
                <div className="label">When</div>
                <input
                  className="input"
                  type="datetime-local"
                  value={logOccurredAt}
                  onChange={(e) => setLogOccurredAt(e.target.value)}
                />
              </div>
            </div>

            <div className="field" style={{ marginTop: 10 }}>
              <div className="label">Note (optional)</div>
              <textarea
                className="textarea"
                value={logSummary}
                onChange={(e) => setLogSummary(e.target.value)}
                placeholder="What was said, what came up, anything to remember for next time…"
                style={{ minHeight: 80 }}
              />
            </div>

            <div className="rowResponsive" style={{ marginTop: 12 }}>
              <button className="btn btnPrimary btnFullMobile" onClick={saveTouch} disabled={savingTouch}>
                {savingTouch ? "Saving…" : "Save"}
              </button>
              <button className="btn btnFullMobile" onClick={() => setLogOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}