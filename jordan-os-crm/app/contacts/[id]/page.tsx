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
  email: string | null;
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

function fmt(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function pickChannel(category: string): Touch["channel"] {
  const cat = (category || "").toLowerCase();
  if (cat === "agent" || cat === "developer" || cat === "vendor") return "email";
  return "text";
}

export default function ContactDetailPage() {
  const params = useParams();
  const id = (params?.id as string) || "";

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [contact, setContact] = useState<Contact | null>(null);
  const [touches, setTouches] = useState<Touch[]>([]);

  // Edit contact
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Client");
  const [tier, setTier] = useState<"A" | "B" | "C">("A");
  const [clientType, setClientType] = useState("");
  const [email, setEmail] = useState("");
  const [savingContact, setSavingContact] = useState(false);

  // Log touch modal
  const [logOpen, setLogOpen] = useState(false);
  const [logChannel, setLogChannel] = useState<Touch["channel"]>("text");
  const [logIntent, setLogIntent] = useState<TouchIntent>("check_in");
  const [logSummary, setLogSummary] = useState("");
  const [logSource, setLogSource] = useState("manual");
  const [logLink, setLogLink] = useState("");
  const [savingTouch, setSavingTouch] = useState(false);

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
    setMsg(null);

    const sess = await requireSession();
    if (!sess) return;

    const { data: cData, error: cErr } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, client_type, email, created_at")
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

    // seed edit fields
    setName(c.display_name || "");
    setCategory(c.category || "Client");
    setTier(((c.tier || "A").toUpperCase() as any) || "A");
    setClientType(c.client_type || "");
    setEmail(c.email || "");

    const { data: tData, error: tErr } = await supabase
      .from("touches")
      .select("id, contact_id, channel, direction, occurred_at, intent, summary, source, source_link")
      .eq("contact_id", id)
      .order("occurred_at", { ascending: false })
      .limit(800);

    if (tErr) {
      setError((prev) => prev ?? `Touches fetch error: ${tErr.message}`);
      setTouches([]);
      return;
    }

    setTouches((tData ?? []) as Touch[]);
  }

  const lastOutbound = useMemo(() => {
    const t = touches.find((x) => x.direction === "outbound");
    return t ? t.occurred_at : null;
  }, [touches]);

  const outboundCount30 = useMemo(() => {
    const now = Date.now();
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    return touches.filter((t) => t.direction === "outbound" && new Date(t.occurred_at).getTime() >= cutoff).length;
  }, [touches]);

  const inboundCount30 = useMemo(() => {
    const now = Date.now();
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    return touches.filter((t) => t.direction === "inbound" && new Date(t.occurred_at).getTime() >= cutoff).length;
  }, [touches]);

  async function saveContact() {
    if (!contact) return;
    setSavingContact(true);
    setError(null);
    setMsg(null);

    const { error: updErr } = await supabase
      .from("contacts")
      .update({
        display_name: name.trim(),
        category,
        tier,
        client_type: clientType.trim() ? clientType.trim() : null,
        email: email.trim() ? email.trim().toLowerCase() : null,
      })
      .eq("id", contact.id);

    setSavingContact(false);

    if (updErr) {
      setError(`Update contact error: ${updErr.message}`);
      return;
    }

    setEditing(false);
    setMsg("Saved.");
    await fetchAll();
  }

  function openLog() {
    if (!contact) return;
    setLogOpen(true);
    setLogChannel(pickChannel(contact.category));
    setLogIntent("check_in");
    setLogSummary("");
    setLogSource("manual");
    setLogLink("");
  }

  async function saveTouch() {
    if (!contact) return;
    setSavingTouch(true);
    setError(null);
    setMsg(null);

    const { error: insErr } = await supabase.from("touches").insert({
      contact_id: contact.id,
      channel: logChannel,
      direction: "outbound",
      intent: logIntent,
      occurred_at: new Date().toISOString(),
      summary: logSummary.trim() ? logSummary.trim() : null,
      source: logSource.trim() ? logSource.trim() : null,
      source_link: logLink.trim() ? logLink.trim() : null,
    });

    setSavingTouch(false);

    if (insErr) {
      setError(`Insert touch error: ${insErr.message}`);
      return;
    }

    setLogOpen(false);
    setMsg("Touch saved.");
    await fetchAll();
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

  if (!ready) return <div className="page">Loading…</div>;

  if (!contact) {
    return (
      <div className="page">
        <div className="card cardPad">
          <div style={{ fontWeight: 900, fontSize: 18 }}>Contact not found</div>
          {error ? <div style={{ marginTop: 10, color: "#8a0000", fontWeight: 900 }}>{error}</div> : null}
          <div style={{ marginTop: 14 }}>
            <a href="/contacts">← Back to Contacts</a>
          </div>
        </div>
      </div>
    );
  }

  const headline = `${prettyCategory(contact.category)}${contact.tier ? ` • Tier ${contact.tier}` : ""}${
    contact.client_type ? ` • ${contact.client_type}` : ""
  }`;

  return (
    <div className="page">
      <div className="pageHeader">
        <div style={{ minWidth: 0 }}>
          <h1 className="h1" style={{ wordBreak: "break-word" }}>
            {contact.display_name}
          </h1>
          <div className="muted" style={{ marginTop: 8 }}>
            <span className="badge badgeGold">{headline}</span>{" "}
            {contact.email ? <span className="badge">{contact.email}</span> : <span className="badge">No email on file</span>}
          </div>

          <div className="muted small" style={{ marginTop: 10 }}>
            Last outbound: <span className="bold">{fmt(lastOutbound)}</span>
          </div>
        </div>

        <div className="row">
          <a className="btn" href="/morning">
            Morning
          </a>
          <a className="btn" href="/contacts">
            Contacts
          </a>
          <button className="btn" onClick={() => setEditing((v) => !v)}>
            {editing ? "Close edit" : "Edit"}
          </button>
          <button className="btn btnPrimary" onClick={openLog}>
            Log outbound
          </button>
        </div>
      </div>

      {(error || msg) && (
        <div className="card cardPad" style={{ marginTop: 14, borderColor: error ? "rgba(160,0,0,0.25)" : undefined }}>
          <div style={{ fontWeight: 900, color: error ? "#8a0000" : "#0b6b2a", whiteSpace: "pre-wrap" }}>{error || msg}</div>
        </div>
      )}

      {/* Metrics strip */}
      <div className="section">
        <div className="row">
          <span className="badge">30d outbound: {outboundCount30}</span>
          <span className="badge">30d inbound: {inboundCount30}</span>
          <span className="badge">Touch history: {touches.length}</span>
        </div>
      </div>

      {/* Edit */}
      {editing && (
        <div className="section">
          <div className="card cardPad">
            <div className="sectionTitleRow" style={{ marginBottom: 6 }}>
              <div className="sectionTitle">Edit contact</div>
              <div className="sectionSub">Keep data minimal; keep it accurate.</div>
            </div>

            <div className="row" style={{ alignItems: "stretch" }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div className="small muted bold" style={{ marginBottom: 6 }}>
                  Name
                </div>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </div>

              <div style={{ width: 220, minWidth: 200 }}>
                <div className="small muted bold" style={{ marginBottom: 6 }}>
                  Category
                </div>
                <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option>Client</option>
                  <option>Agent</option>
                  <option>Developer</option>
                  <option>Vendor</option>
                  <option>Other</option>
                </select>
              </div>

              <div style={{ width: 220, minWidth: 200 }}>
                <div className="small muted bold" style={{ marginBottom: 6 }}>
                  Tier
                </div>
                <select className="select" value={tier} onChange={(e) => setTier(e.target.value as any)}>
                  <option value="A">A</option>
                  <option value="B">B</option>
                  <option value="C">C</option>
                </select>
              </div>
            </div>

            <div className="row" style={{ marginTop: 10, alignItems: "stretch" }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div className="small muted bold" style={{ marginBottom: 6 }}>
                  Client Type (optional)
                </div>
                <input
                  className="input"
                  value={clientType}
                  onChange={(e) => setClientType(e.target.value)}
                  placeholder="buyer / seller / lead / past_client / landlord / tenant / sphere..."
                />
              </div>

              <div style={{ flex: 1, minWidth: 260 }}>
                <div className="small muted bold" style={{ marginBottom: 6 }}>
                  Primary email (optional)
                </div>
                <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@email.com" />
              </div>
            </div>

            <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setEditing(false)} disabled={savingContact}>
                Cancel
              </button>
              <button className="btn btnPrimary" onClick={saveContact} disabled={savingContact}>
                {savingContact ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Touch History */}
      <div className="section">
        <div className="sectionTitleRow">
          <div className="sectionTitle">Touch history</div>
          <div className="sectionSub">Outbound resets cadence. Inbound is tracked.</div>
        </div>

        {touches.length === 0 ? (
          <div className="card cardPad">
            <div className="muted">No touches yet.</div>
          </div>
        ) : (
          <div className="stack">
            {touches.map((t) => (
              <div key={t.id} className="card cardPad">
                <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                  <div style={{ fontWeight: 900 }}>
                    {t.direction.toUpperCase()} • {t.channel}
                    {t.intent ? <span className="muted" style={{ fontWeight: 800 }}> • {t.intent}</span> : null}
                  </div>
                  <div className="muted small">{fmt(t.occurred_at)}</div>
                </div>

                {t.summary ? <div style={{ marginTop: 10, lineHeight: 1.5 }}>{t.summary}</div> : null}

                <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
                  <div className="muted small">
                    {t.source ? <span className="badge">source: {t.source}</span> : null}
                  </div>
                  {t.source_link ? (
                    <a className="btn" href={t.source_link} target="_blank" rel="noreferrer">
                      Open thread
                    </a>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Log touch modal */}
      {logOpen && (
        <div className="modalBackdrop">
          <div className="modal">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Log outbound touch</div>
                <div className="muted small" style={{ marginTop: 4 }}>
                  {contact.display_name}
                </div>
              </div>
              <button className="btn" onClick={() => setLogOpen(false)} disabled={savingTouch}>
                Close
              </button>
            </div>

            <div className="hr" />

            <div className="row" style={{ alignItems: "stretch" }}>
              <div style={{ width: 220, minWidth: 200 }}>
                <div className="small muted bold" style={{ marginBottom: 6 }}>
                  Channel
                </div>
                <select className="select" value={logChannel} onChange={(e) => setLogChannel(e.target.value as any)}>
                  <option value="email">email</option>
                  <option value="text">text</option>
                  <option value="call">call</option>
                  <option value="in_person">in_person</option>
                  <option value="social_dm">social_dm</option>
                  <option value="other">other</option>
                </select>
              </div>

              <div style={{ width: 260, minWidth: 220 }}>
                <div className="small muted bold" style={{ marginBottom: 6 }}>
                  Intent
                </div>
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

              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="small muted bold" style={{ marginBottom: 6 }}>
                  Source
                </div>
                <input className="input" value={logSource} onChange={(e) => setLogSource(e.target.value)} placeholder="manual / gmail / sms" />
              </div>
            </div>

            <div className="row" style={{ marginTop: 10 }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <div className="small muted bold" style={{ marginBottom: 6 }}>
                  Link (optional)
                </div>
                <input className="input" value={logLink} onChange={(e) => setLogLink(e.target.value)} placeholder="thread link / calendar link" />
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <div className="small muted bold" style={{ marginBottom: 6 }}>
                Summary (optional)
              </div>
              <textarea className="textarea" value={logSummary} onChange={(e) => setLogSummary(e.target.value)} placeholder="Quick note about what you sent / what happened" />
            </div>

            <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
              <button className="btn" onClick={() => setLogOpen(false)} disabled={savingTouch}>
                Cancel
              </button>
              <button className="btn btnPrimary" onClick={saveTouch} disabled={savingTouch}>
                {savingTouch ? "Saving…" : "Save touch"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}