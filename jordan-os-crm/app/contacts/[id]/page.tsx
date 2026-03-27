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
  archived: boolean;
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
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesValue, setNotesValue] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);

  const [logOpen, setLogOpen] = useState(false);
  const [logChannel, setLogChannel] = useState<Touch["channel"]>("text");
  const [logDirection, setLogDirection] = useState<Touch["direction"]>("outbound");
  const [logIntent, setLogIntent] = useState<TouchIntent>("check_in");
  const [logOccurredAt, setLogOccurredAt] = useState<string>("");
  const [logSummary, setLogSummary] = useState("");
  const [savingTouch, setSavingTouch] = useState(false);

  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);

  // merge
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeQ, setMergeQ] = useState("");
  const [mergeResults, setMergeResults] = useState<{ id: string; display_name: string; category: string; tier: string | null }[]>([]);
  const [mergeTarget, setMergeTarget] = useState<{ id: string; display_name: string } | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeMsg, setMergeMsg] = useState<string | null>(null);

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
      .select("id, display_name, category, tier, client_type, notes, company, email, phone, created_at, archived, user_id")
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

  async function saveNotes() {
    if (!contact) return;
    setSavingNotes(true);
    const { error } = await supabase
      .from("contacts")
      .update({ notes: notesValue.trim() || null })
      .eq("id", contact.id);
    setSavingNotes(false);
    if (error) { setError(`Notes save error: ${error.message}`); return; }
    setEditingNotes(false);
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

  async function searchMergeContacts(q: string) {
    if (!uid || q.trim().length < 2) { setMergeResults([]); return; }
    const res = await fetch(`/api/contacts/search?uid=${uid}&q=${encodeURIComponent(q.trim())}`);
    const j = await res.json().catch(() => ({}));
    setMergeResults((j.results || []).filter((r: any) => r.id !== id));
  }

  async function mergeIntoTarget() {
    if (!mergeTarget || !uid) return;
    setMerging(true);
    setMergeMsg(null);
    const res = await fetch("/api/contacts/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, source_id: id, target_id: mergeTarget.id }),
    });
    const j = await res.json().catch(() => ({}));
    setMerging(false);
    if (!res.ok) { setMergeMsg(`Error: ${j?.error || "Merge failed"}`); return; }
    window.location.href = `/contacts/${mergeTarget.id}`;
  }

  async function archiveContact() {
    if (!contact) return;
    const isArchived = contact.archived;
    setArchiving(true);
    setError(null);
    const { error } = await supabase
      .from("contacts")
      .update({ archived: !isArchived })
      .eq("id", contact.id);
    setArchiving(false);
    if (error) { setError(`Archive error: ${error.message}`); return; }
    if (!isArchived) {
      window.location.href = "/contacts";
    } else {
      await fetchAll();
    }
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

  const daysSinceOutbound = lastOutbound
    ? Math.floor((Date.now() - lastOutbound.getTime()) / (1000 * 60 * 60 * 24))
    : null;

  // rough cadence for display on this page
  const cadence = (() => {
    const cat = (contact.category || "").toLowerCase();
    const t = (contact.tier || "").toUpperCase();
    if (cat === "client") return t === "A" ? 30 : t === "B" ? 60 : 90;
    if (cat === "sphere") return t === "A" ? 60 : t === "B" ? 90 : 120;
    if (cat === "agent") return t === "A" ? 30 : 60;
    return 60;
  })();

  const overdue = daysSinceOutbound == null || daysSinceOutbound >= cadence;
  const outboundCount = touches.filter((t) => t.direction === "outbound").length;

  return (
    <div className="page">
      {/* Back */}
      <div style={{ marginBottom: 8 }}>
        <a href="/contacts" className="muted small" style={{ textDecoration: "none" }}>
          ← Contacts
        </a>
      </div>

      {contact.archived && (
        <div style={{ marginBottom: 10, padding: "8px 12px", background: "#fef9c3", border: "1px solid #fcd34d", borderRadius: 8, fontSize: 13, color: "#92400e", fontWeight: 600 }}>
          Archived — this contact is hidden from all lists.{" "}
          <button onClick={archiveContact} disabled={archiving} style={{ background: "none", border: "none", cursor: "pointer", fontWeight: 700, textDecoration: "underline", color: "#92400e", padding: 0 }}>
            Unarchive
          </button>
        </div>
      )}

      {error ? <div className="alert alertError" style={{ marginBottom: 10 }}>{error}</div> : null}

      {/* Hero header */}
      <div className="card cardPad" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
          {/* Left: identity */}
          <div style={{ flex: 1, minWidth: 220 }}>
            <h1 className="h1" style={{ margin: 0, lineHeight: 1.1 }}>{contact.display_name}</h1>

            <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
              <span className="badge" style={{ fontWeight: 700 }}>
                {prettyCategory(contact.category)}
                {contact.tier ? ` · Tier ${contact.tier}` : ""}
              </span>
              {contact.client_type && <span className="badge">{contact.client_type}</span>}
              {contact.company && <span className="badge">{contact.company}</span>}
            </div>

            {(contact.email || contact.phone) && (
              <div className="row" style={{ marginTop: 10, gap: 14, flexWrap: "wrap" }}>
                {contact.email && (
                  <a href={`mailto:${contact.email}`} style={{ fontSize: 13, color: "#333", textDecoration: "underline", textUnderlineOffset: 2 }}>
                    {contact.email}
                  </a>
                )}
                {contact.phone && (
                  <a href={`tel:${contact.phone}`} style={{ fontSize: 13, color: "#333", textDecoration: "underline", textUnderlineOffset: 2 }}>
                    {contact.phone}
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Right: days counter */}
          <div style={{ textAlign: "center", minWidth: 90 }}>
            <div style={{ fontSize: 40, fontWeight: 900, lineHeight: 1, color: overdue ? "#b91c1c" : "#15803d" }}>
              {daysSinceOutbound == null ? "∞" : daysSinceOutbound}
            </div>
            <div style={{ fontSize: 11, color: "#888", marginTop: 3, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {daysSinceOutbound == null ? "never reached out" : "days since outreach"}
            </div>
            <div style={{ marginTop: 6 }}>
              <span className="badge" style={{ fontSize: 11, color: overdue ? "#b91c1c" : "#15803d", borderColor: overdue ? "#fca5a5" : "#86efac" }}>
                {overdue ? "Overdue" : "On track"}
              </span>
            </div>
          </div>
        </div>

        {/* Stats row */}
        <div className="row" style={{ marginTop: 16, paddingTop: 14, borderTop: "1px solid rgba(0,0,0,0.07)", flexWrap: "wrap" }}>
          <span className="badge">{outboundCount} outbound touch{outboundCount !== 1 ? "es" : ""}</span>
          <span className="badge">{touches.length} total interactions</span>
          <span className="badge">Cadence {cadence}d</span>
          {lastOutbound && (
            <span className="badge muted">
              Last: {lastOutbound.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="row" style={{ marginTop: 14, gap: 8 }}>
          <button className="btn btnPrimary" onClick={openLog}>Log outreach</button>
          <button className="btn" onClick={() => setEditing((v) => !v)}>
            {editing ? "Close edit" : "Edit contact"}
          </button>
        </div>
      </div>

      {/* Edit panel */}
      {editing && (
        <div className="card cardPad stack" style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 900, fontSize: 15 }}>Edit contact</div>

          <div className="fieldGridMobile" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <div className="label">Name</div>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field" style={{ width: 180 }}>
              <div className="label">Category</div>
              <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option>Client</option><option>Sphere</option><option>Agent</option><option>Developer</option>
                <option>Vendor</option><option>Other</option>
              </select>
            </div>
            <div className="field" style={{ width: 110 }}>
              <div className="label">Tier</div>
              <select className="select" value={tier} onChange={(e) => setTier(e.target.value as any)}>
                <option value="A">A</option><option value="B">B</option><option value="C">C</option>
              </select>
            </div>
          </div>

          <div className="fieldGridMobile" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ flex: 1, minWidth: 180 }}>
              <div className="label">Client type</div>
              <input className="input" value={clientType} onChange={(e) => setClientType(e.target.value)} placeholder="buyer / seller / sphere…" />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 180 }}>
              <div className="label">Company</div>
              <input className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Compass, etc." />
            </div>
          </div>

          <div className="row">
            <button className="btn btnPrimary" onClick={saveContact} disabled={savingContact}>
              {savingContact ? "Saving…" : "Save"}
            </button>
            <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
          </div>

          <div className="hr" />
          <div style={{ fontWeight: 900, fontSize: 13, color: "#555" }}>Danger zone</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" style={{ color: "#92400e", borderColor: "#fcd34d" }} onClick={archiveContact} disabled={archiving}>
              {archiving ? "Saving…" : contact.archived ? "Unarchive" : "Archive contact"}
            </button>
            <button className="btn" style={{ color: "#b91c1c", borderColor: "#fca5a5" }} onClick={deleteContact} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete contact"}
            </button>
          </div>
          <div className="muted small">Archive hides from all lists. Delete removes all data permanently.</div>

          <div className="hr" />
          <div style={{ fontWeight: 900, fontSize: 13, color: "#555" }}>Merge into another contact</div>
          <div className="muted small">Moves all touches from this contact into another, then archives this one.</div>
          {!mergeOpen ? (
            <button className="btn" style={{ alignSelf: "flex-start" }} onClick={() => setMergeOpen(true)}>
              Merge contact…
            </button>
          ) : (
            <div className="stack">
              {mergeTarget ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "rgba(0,0,0,0.04)", borderRadius: 6 }}>
                  <div style={{ flex: 1, fontWeight: 700 }}>
                    Merge into: <span style={{ color: "#1d4ed8" }}>{mergeTarget.display_name}</span>
                  </div>
                  <button className="btn" style={{ fontSize: 12 }} onClick={() => setMergeTarget(null)}>Change</button>
                </div>
              ) : (
                <div>
                  <input
                    className="input"
                    placeholder="Search for target contact…"
                    value={mergeQ}
                    onChange={(e) => { setMergeQ(e.target.value); searchMergeContacts(e.target.value); }}
                    autoFocus
                  />
                  {mergeResults.length > 0 && (
                    <div style={{ marginTop: 4, border: "1px solid rgba(0,0,0,0.1)", borderRadius: 6, overflow: "hidden" }}>
                      {mergeResults.map((r) => (
                        <div
                          key={r.id}
                          style={{ padding: "8px 12px", cursor: "pointer", borderBottom: "1px solid rgba(0,0,0,0.06)", fontSize: 13 }}
                          onClick={() => { setMergeTarget(r); setMergeQ(""); setMergeResults([]); }}
                        >
                          <span style={{ fontWeight: 700 }}>{r.display_name}</span>
                          <span className="muted" style={{ marginLeft: 8 }}>{r.category}{r.tier ? ` · ${r.tier}` : ""}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {mergeMsg && (
                <div style={{ fontSize: 13, fontWeight: 700, color: mergeMsg.startsWith("Error") ? "#b91c1c" : "#15803d" }}>{mergeMsg}</div>
              )}

              <div style={{ display: "flex", gap: 8 }}>
                {mergeTarget && (
                  <button
                    className="btn btnPrimary"
                    onClick={mergeIntoTarget}
                    disabled={merging}
                  >
                    {merging ? "Merging…" : `Merge into ${mergeTarget.display_name}`}
                  </button>
                )}
                <button className="btn" onClick={() => { setMergeOpen(false); setMergeTarget(null); setMergeQ(""); setMergeResults([]); setMergeMsg(null); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Notes — inline edit */}
      <div className="card cardPad" style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontWeight: 900 }}>Notes</div>
          {!editingNotes ? (
            <button className="btn" style={{ fontSize: 12 }} onClick={() => { setNotesValue(contact.notes || ""); setEditingNotes(true); }}>
              {contact.notes ? "Edit" : "Add notes"}
            </button>
          ) : (
            <div className="row" style={{ gap: 6 }}>
              <button className="btn btnPrimary" style={{ fontSize: 12 }} onClick={saveNotes} disabled={savingNotes}>
                {savingNotes ? "Saving…" : "Save"}
              </button>
              <button className="btn" style={{ fontSize: 12 }} onClick={() => setEditingNotes(false)}>Cancel</button>
            </div>
          )}
        </div>

        {editingNotes ? (
          <textarea
            className="textarea"
            value={notesValue}
            onChange={(e) => setNotesValue(e.target.value)}
            placeholder="Relationship context, deal status, key details — anything useful for the next conversation…"
            style={{ minHeight: 120 }}
            autoFocus
          />
        ) : contact.notes ? (
          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: 14 }}>{contact.notes}</div>
        ) : (
          <div className="muted" style={{ fontSize: 13 }}>
            No notes yet — capture context, deal status, and details useful for the next conversation.
          </div>
        )}
      </div>

      {/* Touch timeline */}
      <div className="card cardPad" style={{ marginBottom: 12 }}>
        <div style={{ fontWeight: 900, marginBottom: touches.length > 0 ? 16 : 0 }}>
          Outreach history
          <span className="muted" style={{ fontWeight: 400, fontSize: 13, marginLeft: 8 }}>({touches.length})</span>
        </div>

        {touches.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>No outreach logged yet.</div>
        ) : (
          <div className="stack" style={{ gap: 0 }}>
            {touches.map((t, i) => (
              <div key={t.id} style={{ display: "flex", gap: 14, paddingBottom: i < touches.length - 1 ? 16 : 0 }}>
                {/* Date column */}
                <div style={{ width: 68, textAlign: "right", flexShrink: 0, paddingTop: 2 }}>
                  <div style={{ fontSize: 12, color: "#888", fontWeight: 600, lineHeight: 1.3 }}>
                    {new Date(t.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </div>
                  <div style={{ fontSize: 11, color: "#aaa" }}>
                    {new Date(t.occurred_at).getFullYear()}
                  </div>
                </div>

                {/* Line */}
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: t.direction === "outbound" ? "#2563eb" : "#9ca3af", marginTop: 4, flexShrink: 0 }} />
                  {i < touches.length - 1 && <div style={{ width: 1, flex: 1, background: "#e5e7eb", marginTop: 4 }} />}
                </div>

                {/* Content */}
                <div style={{ flex: 1, paddingBottom: 4 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    {t.direction === "outbound" ? "You reached out" : "They reached out"}
                    <span style={{ fontWeight: 400, color: "#666", marginLeft: 6 }}>
                      via {channelLabel(t.channel)}
                      {t.intent && t.intent !== "check_in" ? ` · ${intentLabel(t.intent)}` : ""}
                    </span>
                  </div>
                  {t.summary && (
                    <div style={{ marginTop: 4, fontSize: 13, color: "#444", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{t.summary}</div>
                  )}
                  {t.source_link && (
                    <div style={{ marginTop: 4 }}>
                      <a href={t.source_link} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#555", textDecoration: "underline", textUnderlineOffset: 2 }}>
                        {t.source === "gmail" ? "View in Gmail" : "View thread"}
                      </a>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* AI draft + text upload — collapsed by default */}
      <details className="card cardPad" style={{ marginBottom: 12 }}>
        <summary style={{ cursor: "pointer", fontWeight: 900, listStyle: "none", userSelect: "none" }}>
          AI draft + text thread upload
          <span className="muted" style={{ fontWeight: 400, fontSize: 13, marginLeft: 8 }}>expand</span>
        </summary>
        <div style={{ marginTop: 14 }}>
          <VoiceDraftPanel contactId={contact.id} />
          <TextThreadUploadPanel contactId={contact.id} />
        </div>
      </details>

      {/* Log outreach modal */}
      {logOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            padding: 16,
            zIndex: 999,
          }}
        >
          <div className="card cardPad" style={{ width: "min(600px, 100%)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 17 }}>Log outreach</div>
                <div className="muted" style={{ marginTop: 3 }}>{contact.display_name}</div>
              </div>
              <button className="btn" onClick={() => setLogOpen(false)}>✕</button>
            </div>

            <div className="fieldGridMobile" style={{ alignItems: "flex-end" }}>
              <div className="field" style={{ width: 180 }}>
                <div className="label">Who reached out</div>
                <select className="select" value={logDirection} onChange={(e) => setLogDirection(e.target.value as any)}>
                  <option value="outbound">I reached out</option>
                  <option value="inbound">They reached out</option>
                </select>
              </div>
              <div className="field" style={{ width: 150 }}>
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
              <div className="field" style={{ width: 180 }}>
                <div className="label">Purpose</div>
                <select className="select" value={logIntent} onChange={(e) => setLogIntent(e.target.value as any)}>
                  <option value="check_in">Check-in</option>
                  <option value="deal_followup">Deal follow-up</option>
                  <option value="referral_ask">Referral ask</option>
                  <option value="review_ask">Review ask</option>
                  <option value="collaboration">Collaboration</option>
                  <option value="event_invite">Event invite</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div className="field" style={{ width: 190 }}>
                <div className="label">When</div>
                <input className="input" type="datetime-local" value={logOccurredAt} onChange={(e) => setLogOccurredAt(e.target.value)} />
              </div>
            </div>

            <div className="field" style={{ marginTop: 12 }}>
              <div className="label">Note (optional)</div>
              <textarea
                className="textarea"
                value={logSummary}
                onChange={(e) => setLogSummary(e.target.value)}
                placeholder="What was said, what came up, anything useful for next time…"
                style={{ minHeight: 80 }}
              />
            </div>

            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn btnPrimary" onClick={saveTouch} disabled={savingTouch}>
                {savingTouch ? "Saving…" : "Save"}
              </button>
              <button className="btn" onClick={() => setLogOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}