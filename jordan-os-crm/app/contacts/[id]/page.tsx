"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

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

type TextThreadRow = {
  id: string;
  title: string | null;
  summary: string | null;
  last_activity_at: string | null;
  created_at: string;
};

function prettyCategory(c: string) {
  const s = (c || "").trim();
  if (!s) return "Other";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function toDatetimeLocalValue(d: Date) {
  // datetime-local expects local "YYYY-MM-DDTHH:MM"
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function parseDatetimeLocalToISO(v: string) {
  // v like "2026-03-02T10:30" interpreted as local time
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export default function ContactDetailPage() {
  const params = useParams();
  const id = (params?.id as string) || "";

  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
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
  const [logSummary, setLogSummary] = useState("");
  const [logSource, setLogSource] = useState("manual");
  const [logLink, setLogLink] = useState("");
  const [logOccurredAt, setLogOccurredAt] = useState<string>(() => toDatetimeLocalValue(new Date()));
  const [savingTouch, setSavingTouch] = useState(false);

  // Text thread upload
  const [threadTitle, setThreadTitle] = useState("");
  const [threadRaw, setThreadRaw] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);

  // Recent imported threads (optional display)
  const [threads, setThreads] = useState<TextThreadRow[]>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);

  const lastOutbound = useMemo(() => {
    const t = touches.find((x) => x.direction === "outbound");
    return t ? new Date(t.occurred_at) : null;
  }, [touches]);

  async function requireSession() {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user ?? null;
    if (!user) {
      window.location.href = "/login";
      return null;
    }
    setUid(user.id);
    return data.session!;
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

  async function fetchThreads() {
    if (!uid) return;
    setLoadingThreads(true);

    const { data, error } = await supabase
      .from("text_threads")
      .select("id, title, summary, last_activity_at, created_at")
      .eq("user_id", uid)
      .eq("contact_id", id)
      .order("created_at", { ascending: false })
      .limit(20);

    setLoadingThreads(false);

    if (error) {
      // Keep it non-blocking; threads list is optional UI
      return;
    }

    setThreads((data ?? []) as TextThreadRow[]);
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
    setLogOccurredAt(toDatetimeLocalValue(new Date()));
  }

  async function saveTouch() {
    if (!contact) return;
    setSavingTouch(true);
    setError(null);

    const occurredISO = parseDatetimeLocalToISO(logOccurredAt) || new Date().toISOString();

    const { error } = await supabase.from("touches").insert({
      contact_id: contact.id,
      channel: logChannel,
      direction: logDirection,
      intent: logIntent,
      occurred_at: occurredISO,
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

  async function importThread() {
    setImportErr(null);
    setImportMsg(null);

    if (!uid) return setImportErr("Not signed in.");
    if (!contact) return setImportErr("No contact loaded.");
    if (!threadRaw.trim() || threadRaw.trim().length < 20) return setImportErr("Paste a longer iMessage thread.");

    setImportBusy(true);

    try {
      const res = await fetch("/api/text/imessage/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uid,
          contact_id: contact.id,
          title: threadTitle.trim() || null,
          raw_text: threadRaw,
        }),
      });

      const j = await res.json();

      if (!res.ok) {
        setImportErr(j?.error || "Import failed");
      } else {
        setImportMsg(`Imported ✅ Messages inserted: ${j.inserted_messages ?? "?"}`);
        setThreadTitle("");
        setThreadRaw("");
        await fetchThreads();
      }
    } catch (e: any) {
      setImportErr(e?.message || "Import failed");
    } finally {
      setImportBusy(false);
    }
  }

  useEffect(() => {
    let alive = true;

    const init = async () => {
      const { data } = await supabase.auth.getSession();
      const user = data.session?.user ?? null;

      if (!alive) return;

      if (!user) {
        setTimeout(async () => {
          const { data: d2 } = await supabase.auth.getSession();
          if (!d2.session) window.location.href = "/login";
        }, 250);
        return;
      }

      setUid(user.id);
      setReady(true);
      await fetchAll();
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const user = session?.user ?? null;
      if (!user) window.location.href = "/login";
    });

    init();

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!uid) return;
    fetchThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, id]);

  if (!ready) return <div className="card cardPad">Loading…</div>;

  if (!contact) {
    return (
      <div className="stack">
        <div className="card cardPad">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Contact not found</div>
          {error ? <div className="alert alertError" style={{ marginTop: 10 }}>{error}</div> : null}
          <div style={{ marginTop: 12 }}>
            <a href="/contacts">← Back to Contacts</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="rowBetween">
        <div>
          <div className="row" style={{ alignItems: "baseline" }}>
            <h1 className="h1">{contact.display_name}</h1>
            <span className="subtle">
              {prettyCategory(contact.category)} {contact.tier ? `• Tier ${contact.tier}` : ""}{" "}
              {contact.client_type ? `• ${contact.client_type}` : ""}
            </span>
          </div>

          <div className="subtle" style={{ marginTop: 8, fontSize: 13 }}>
            Last outbound: <strong>{lastOutbound ? lastOutbound.toLocaleString() : "—"}</strong>
          </div>
        </div>

        <div className="row">
          <a className="btn" href="/contacts" style={{ textDecoration: "none" }}>
            Contacts
          </a>
          <button className="btn" onClick={() => setEditing((v) => !v)}>
            {editing ? "Close edit" : "Edit"}
          </button>
          <button className="btn btnPrimary" onClick={openLog}>
            Log touch
          </button>
        </div>
      </div>

      {error ? <div className="alert alertError">{error}</div> : null}

      {editing && (
        <div className="card cardPad stack">
          <div style={{ fontWeight: 900, fontSize: 16 }}>Edit contact</div>

          <div className="row" style={{ alignItems: "flex-end" }}>
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

          <div className="row">
            <button className="btn btnPrimary" onClick={saveContact} disabled={savingContact}>
              {savingContact ? "Saving…" : "Save"}
            </button>
            <button className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Upload text thread */}
      <div className="section" style={{ marginTop: 18 }}>
        <div className="sectionTitleRow">
          <div className="sectionTitle">Upload text thread</div>
          <div className="sectionSub">Paste iMessage thread text → attach to this contact → used for notes + better drafts.</div>
        </div>

        {(importErr || importMsg) && (
          <div className="card cardPad" style={{ borderColor: importErr ? "rgba(160,0,0,0.25)" : undefined }}>
            <div style={{ fontWeight: 900, color: importErr ? "#8a0000" : "#0b6b2a", whiteSpace: "pre-wrap" }}>
              {importErr || importMsg}
            </div>
          </div>
        )}

        <div className="card cardPad">
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <input
              className="input"
              value={threadTitle}
              onChange={(e) => setThreadTitle(e.target.value)}
              placeholder='Optional title (e.g., "Feb 2026 — appliance planning")'
              style={{ flex: 1, minWidth: 260 }}
            />
            <button className="btn btnPrimary" onClick={importThread} disabled={importBusy}>
              {importBusy ? "Importing…" : "Import"}
            </button>
          </div>

          <div style={{ marginTop: 10 }}>
            <textarea
              className="textarea"
              value={threadRaw}
              onChange={(e) => setThreadRaw(e.target.value)}
              placeholder={`Paste an iMessage thread here.\n\nExample:\nJordan: Hey — quick check-in...\nAli: All good...`}
              style={{ minHeight: 220 }}
            />
          </div>

          <div className="muted small" style={{ marginTop: 10 }}>
            Tip: iPhone → Messages → open thread → select text → copy → paste here. Even if parsing isn’t perfect, the raw thread is saved.
          </div>
        </div>

        {/* Recent threads list */}
        <div className="card cardPad" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 900, fontSize: 14 }}>Recent imports</div>
          {loadingThreads ? (
            <div className="muted" style={{ marginTop: 8 }}>Loading…</div>
          ) : threads.length === 0 ? (
            <div className="muted" style={{ marginTop: 8 }}>No imported threads yet.</div>
          ) : (
            <div className="stack" style={{ marginTop: 10 }}>
              {threads.map((t) => (
                <div key={t.id} className="cardSoft cardPad">
                  <div className="rowBetween" style={{ gap: 10 }}>
                    <div style={{ fontWeight: 900, minWidth: 0 }}>
                      {t.title || "Untitled thread"}
                      <div className="muted small" style={{ marginTop: 4 }}>
                        {t.last_activity_at ? `Last activity: ${new Date(t.last_activity_at).toLocaleString()}` : `Imported: ${new Date(t.created_at).toLocaleString()}`}
                      </div>
                    </div>
                  </div>
                  {t.summary ? (
                    <div className="small" style={{ marginTop: 10, whiteSpace: "pre-wrap", lineHeight: 1.45 }}>
                      {t.summary}
                    </div>
                  ) : (
                    <div className="muted small" style={{ marginTop: 10 }}>
                      No summary saved (optional columns may not exist yet).
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Touch history */}
      <div className="card cardPad stack">
        <div style={{ fontWeight: 900, fontSize: 16 }}>Touch history</div>

        {touches.length === 0 ? (
          <div className="subtle">No touches yet.</div>
        ) : (
          <div className="stack">
            {touches.map((t) => (
              <div key={t.id} className="card cardPad">
                <div className="rowBetween">
                  <div style={{ fontWeight: 900 }}>
                    {t.direction.toUpperCase()} • {t.channel}
                    {t.intent ? <span className="subtle"> • {t.intent}</span> : null}
                  </div>
                  <div className="subtle">{new Date(t.occurred_at).toLocaleString()}</div>
                </div>

                {t.summary ? <div style={{ marginTop: 10 }}>{t.summary}</div> : null}

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

      {/* Log touch modal */}
      {logOpen && (
        <div
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
          <div className="card cardPad" style={{ width: "min(900px, 100%)" }}>
            <div className="rowBetween">
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Log touch</div>
                <div className="subtle" style={{ marginTop: 4 }}>
                  {contact.display_name}
                </div>
              </div>
              <button className="btn" onClick={() => setLogOpen(false)}>
                Close
              </button>
            </div>

            <div className="row" style={{ marginTop: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div className="field" style={{ width: 220 }}>
                <div className="label">When</div>
                <input
                  className="input"
                  type="datetime-local"
                  value={logOccurredAt}
                  onChange={(e) => setLogOccurredAt(e.target.value)}
                />
              </div>

              <div className="field" style={{ width: 160 }}>
                <div className="label">Direction</div>
                <select className="select" value={logDirection} onChange={(e) => setLogDirection(e.target.value as any)}>
                  <option value="outbound">outbound</option>
                  <option value="inbound">inbound</option>
                </select>
              </div>

              <div className="field" style={{ width: 160 }}>
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

              <div className="field" style={{ width: 220 }}>
                <div className="label">Intent</div>
                <select className="select" value={logIntent} onChange={(e) => setLogIntent(e.target.value as any)}>
                  <option value="check_in">check_in</option>
                  <option value="referral_ask">referral_ask</option>
                  <option value="review_ask">review_ask</option>
                  <option value="deal_followup">deal_followup</option>
                  <option value="collaboration">collaboration</option>
                  <option value="event_invite">event_invite</option>
                  <option value="event_invite">event_invite</option>
                  <option value="other">other</option>
                </select>
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

            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn btnPrimary" onClick={saveTouch} disabled={savingTouch}>
                {savingTouch ? "Saving…" : "Save touch"}
              </button>
              <button className="btn" onClick={() => setLogOpen(false)}>
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