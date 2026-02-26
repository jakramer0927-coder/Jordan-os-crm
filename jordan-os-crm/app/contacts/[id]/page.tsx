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

type GmailThreadPreview = {
  threadId: string;
  subject: string;
  date: string;
  from: string;
  to: string;
  snippet: string;
  link: string;
  messageCount: number;
};

function categoryPretty(c: string) {
  const s = (c || "").trim();
  if (!s) return "Other";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export default function ContactDetailPage() {
  const params = useParams();
  const id = (params?.id as string) || "";

  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  // Log touch
  const [logOpen, setLogOpen] = useState(false);
  const [logChannel, setLogChannel] = useState<Touch["channel"]>("text");
  const [logDirection, setLogDirection] = useState<Touch["direction"]>("outbound");
  const [logIntent, setLogIntent] = useState<TouchIntent>("check_in");
  const [logSummary, setLogSummary] = useState("");
  const [logSource, setLogSource] = useState("manual");
  const [logLink, setLogLink] = useState("");
  const [savingTouch, setSavingTouch] = useState(false);

  // Gmail panel
  const [gmailThreads, setGmailThreads] = useState<GmailThreadPreview[]>([]);
  const [gmailQuery, setGmailQuery] = useState<string | null>(null);
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailImporting, setGmailImporting] = useState(false);

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

    setUid(sess.user.id);

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

    const cleanEmail = email.trim().toLowerCase();
    const emailValue = cleanEmail ? cleanEmail : null;

    const { error } = await supabase
      .from("contacts")
      .update({
        display_name: name.trim(),
        category,
        tier,
        client_type: clientType.trim() ? clientType.trim() : null,
        email: emailValue,
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
  }

  async function saveTouch() {
    if (!contact) return;
    setSavingTouch(true);
    setError(null);

    const { error } = await supabase.from("touches").insert({
      contact_id: contact.id,
      channel: logChannel,
      direction: logDirection,
      intent: logIntent,
      occurred_at: new Date().toISOString(),
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

  async function searchGmailThreads() {
    setError(null);
    setGmailLoading(true);
    setGmailThreads([]);
    setGmailQuery(null);

    const sess = await requireSession();
    if (!sess) return;

    const contactEmail = (contact?.email || "").trim().toLowerCase();
    if (!contactEmail) {
      setGmailLoading(false);
      setError("Add an email to this contact first (Edit contact → Email).");
      return;
    }

    const res = await fetch(
      `/api/gmail/contact/threads?uid=${encodeURIComponent(sess.user.id)}&email=${encodeURIComponent(contactEmail)}`
    );
    const text = await res.text();

    let payload: any = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }

    setGmailLoading(false);

    if (!res.ok) {
      setError(payload?.error || text || `Gmail search failed (status ${res.status})`);
      return;
    }

    setGmailThreads((payload?.threads ?? []) as GmailThreadPreview[]);
    setGmailQuery(String(payload?.q || ""));
  }

  async function importGmailForContact() {
    setError(null);
    setGmailImporting(true);

    const sess = await requireSession();
    if (!sess) return;

    const contactEmail = (contact?.email || "").trim().toLowerCase();
    if (!contactEmail) {
      setGmailImporting(false);
      setError("Add an email to this contact first (Edit contact → Email).");
      return;
    }

    const res = await fetch(`/api/gmail/contact/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        uid: sess.user.id,
        contactId: contact!.id,
        email: contactEmail,
        maxThreads: 5,
      }),
    });

    const text = await res.text();
    let payload: any = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }

    setGmailImporting(false);

    if (!res.ok) {
      setError(payload?.error || text || `Gmail import failed (status ${res.status})`);
      return;
    }

    await fetchAll();
  }

  useEffect(() => {
    let alive = true;

    const init = async () => {
      const { data } = await supabase.auth.getSession();
      const u = data.session?.user;
      if (!alive) return;

      if (!u) {
        setTimeout(async () => {
          const { data: d2 } = await supabase.auth.getSession();
          if (!d2.session) window.location.href = "/login";
        }, 250);
        return;
      }

      setUid(u.id);
      setReady(true);
      await fetchAll();
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const u = session?.user;
      if (!u) window.location.href = "/login";
      else setUid(u.id);
    });

    init();

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!ready) return <div style={{ padding: 40 }}>Loading…</div>;

  if (!contact) {
    return (
      <div style={{ padding: 40 }}>
        <div style={{ fontWeight: 900, fontSize: 20 }}>Contact not found</div>
        {error ? <div style={{ marginTop: 10, color: "crimson", fontWeight: 800 }}>{error}</div> : null}
        <div style={{ marginTop: 14 }}>
          <a href="/contacts">← Back to Contacts</a>
        </div>
      </div>
    );
  }

  const gmailSearchUrl =
    contact.email && contact.email.trim()
      ? `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(`from:${contact.email} OR to:${contact.email}`)}`
      : null;

  return (
    <div style={{ padding: 40, maxWidth: 1100 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 900 }}>{contact.display_name}</h1>
            <span style={{ color: "#666" }}>
              {categoryPretty(contact.category)} {contact.tier ? `• Tier ${contact.tier}` : ""}{" "}
              {contact.client_type ? `• ${contact.client_type}` : ""}
              {contact.email ? ` • ${contact.email}` : ""}
            </span>
          </div>

          <div style={{ marginTop: 8, color: "#777", fontSize: 13 }}>
            Last outbound: <strong>{lastOutbound ? lastOutbound.toLocaleString() : "—"}</strong>
          </div>

          <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a
              href="/contacts"
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", textDecoration: "none", color: "#111" }}
            >
              ← Contacts
            </a>

            <a
              href="/morning"
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", textDecoration: "none", color: "#111" }}
            >
              Morning
            </a>

            <button
              onClick={() => setEditing((v) => !v)}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
            >
              {editing ? "Close edit" : "Edit contact"}
            </button>

            <button
              onClick={openLog}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
            >
              Log touch
            </button>
          </div>
        </div>

        <div style={{ color: "#999", fontSize: 12, textAlign: "right" }}>{uid ? `user ${uid.slice(0, 8)}…` : ""}</div>
      </div>

      {error ? <div style={{ marginTop: 14, color: "crimson", fontWeight: 800, whiteSpace: "pre-wrap" }}>{error}</div> : null}

      {editing && (
        <div style={{ marginTop: 18, border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Edit contact</div>

          <div style={{ marginTop: 12, display: "grid", gap: 10, gridTemplateColumns: "1fr 200px 200px" }}>
            <label style={{ fontSize: 12, color: "#666" }}>
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{ display: "block", width: "100%", padding: 10, marginTop: 6, borderRadius: 10, border: "1px solid #ddd" }}
              />
            </label>

            <label style={{ fontSize: 12, color: "#666" }}>
              Category
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                style={{ display: "block", width: "100%", padding: 10, marginTop: 6 }}
              >
                <option>Client</option>
                <option>Agent</option>
                <option>Developer</option>
                <option>Vendor</option>
                <option>Other</option>
              </select>
            </label>

            <label style={{ fontSize: 12, color: "#666" }}>
              Tier
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value as any)}
                style={{ display: "block", width: "100%", padding: 10, marginTop: 6 }}
              >
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
              </select>
            </label>
          </div>

          <div style={{ marginTop: 10, display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr" }}>
            <label style={{ fontSize: 12, color: "#666" }}>
              Client Type (optional)
              <input
                value={clientType}
                onChange={(e) => setClientType(e.target.value)}
                placeholder="buyer / seller / past_client / lead / landlord / tenant / sphere ..."
                style={{ display: "block", width: "100%", padding: 10, marginTop: 6, borderRadius: 10, border: "1px solid #ddd" }}
              />
            </label>

            <label style={{ fontSize: 12, color: "#666" }}>
              Email (recommended for Gmail sync)
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@email.com"
                style={{ display: "block", width: "100%", padding: 10, marginTop: 6, borderRadius: 10, border: "1px solid #ddd" }}
              />
            </label>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
            <button
              onClick={saveContact}
              disabled={savingContact}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
            >
              {savingContact ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Gmail panel */}
      <div style={{ marginTop: 18, border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 16 }}>Gmail context</div>
            <div style={{ marginTop: 6, color: "#666", fontSize: 13 }}>
              Pull recent threads for this contact (requires an email on the contact).
              {gmailQuery ? (
                <div style={{ marginTop: 6, color: "#888" }}>
                  query: <code>{gmailQuery}</code>
                </div>
              ) : null}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {gmailSearchUrl ? (
              <a
                href={gmailSearchUrl}
                target="_blank"
                rel="noreferrer"
                style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", textDecoration: "none", color: "#111" }}
              >
                Open Gmail search
              </a>
            ) : null}

            <button
              onClick={searchGmailThreads}
              disabled={gmailLoading}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
            >
              {gmailLoading ? "Searching…" : "Search threads"}
            </button>

            <button
              onClick={importGmailForContact}
              disabled={gmailImporting}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
            >
              {gmailImporting ? "Importing…" : "Import touches"}
            </button>
          </div>
        </div>

        {gmailThreads.length === 0 ? (
          <div style={{ marginTop: 10, color: "#777" }}>No Gmail threads loaded yet.</div>
        ) : (
          <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
            {gmailThreads.map((t) => (
              <div key={t.threadId} style={{ border: "1px solid #eee", borderRadius: 12, padding: 12, background: "#fff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ fontWeight: 900 }}>{t.subject}</div>
                  <div style={{ color: "#777", fontSize: 12 }}>{t.date}</div>
                </div>
                <div style={{ marginTop: 6, color: "#666", fontSize: 12 }}>
                  from: {t.from} • to: {t.to} • messages: {t.messageCount}
                </div>
                {t.snippet ? <div style={{ marginTop: 8, color: "#333" }}>{t.snippet}</div> : null}
                <div style={{ marginTop: 8 }}>
                  <a href={t.link} target="_blank" rel="noreferrer">
                    Open thread
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Touch history */}
      <div style={{ marginTop: 18, border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>Touch history</div>

        {touches.length === 0 ? (
          <div style={{ marginTop: 10, color: "#666" }}>No touches yet.</div>
        ) : (
          <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
            {touches.map((t) => (
              <div key={t.id} style={{ border: "1px solid #eee", borderRadius: 12, padding: 12, background: "#fff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ fontWeight: 900 }}>
                    {t.direction.toUpperCase()} • {t.channel}
                    {t.intent ? <span style={{ color: "#666", fontWeight: 600 }}> • {t.intent}</span> : null}
                  </div>
                  <div style={{ color: "#777" }}>{new Date(t.occurred_at).toLocaleString()}</div>
                </div>

                {t.summary ? <div style={{ marginTop: 8, color: "#333" }}>{t.summary}</div> : null}

                <div style={{ marginTop: 8, color: "#777", fontSize: 12 }}>
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
          }}
        >
          <div style={{ width: "min(820px, 100%)", background: "#fff", borderRadius: 16, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 18 }}>Log touch</div>
                <div style={{ color: "#666", marginTop: 4 }}>{contact.display_name}</div>
              </div>
              <button
                onClick={() => setLogOpen(false)}
                style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
              >
                Close
              </button>
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ fontSize: 12, color: "#666" }}>
                Direction
                <select
                  value={logDirection}
                  onChange={(e) => setLogDirection(e.target.value as any)}
                  style={{ display: "block", padding: 10, marginTop: 6 }}
                >
                  <option value="outbound">outbound</option>
                  <option value="inbound">inbound</option>
                </select>
              </label>

              <label style={{ fontSize: 12, color: "#666" }}>
                Channel
                <select
                  value={logChannel}
                  onChange={(e) => setLogChannel(e.target.value as any)}
                  style={{ display: "block", padding: 10, marginTop: 6 }}
                >
                  <option value="email">email</option>
                  <option value="text">text</option>
                  <option value="call">call</option>
                  <option value="in_person">in_person</option>
                  <option value="social_dm">social_dm</option>
                  <option value="other">other</option>
                </select>
              </label>

              <label style={{ fontSize: 12, color: "#666" }}>
                Intent
                <select
                  value={logIntent}
                  onChange={(e) => setLogIntent(e.target.value as any)}
                  style={{ display: "block", padding: 10, marginTop: 6 }}
                >
                  <option value="check_in">check_in</option>
                  <option value="referral_ask">referral_ask</option>
                  <option value="review_ask">review_ask</option>
                  <option value="deal_followup">deal_followup</option>
                  <option value="collaboration">collaboration</option>
                  <option value="event_invite">event_invite</option>
                  <option value="other">other</option>
                </select>
              </label>

              <label style={{ fontSize: 12, color: "#666", flex: 1, minWidth: 220 }}>
                Source
                <input
                  value={logSource}
                  onChange={(e) => setLogSource(e.target.value)}
                  placeholder="manual / gmail / sms"
                  style={{ display: "block", padding: 10, marginTop: 6, width: "100%", borderRadius: 10, border: "1px solid #ddd" }}
                />
              </label>

              <label style={{ fontSize: 12, color: "#666", flex: 1, minWidth: 260 }}>
                Link (optional)
                <input
                  value={logLink}
                  onChange={(e) => setLogLink(e.target.value)}
                  placeholder="thread link / calendar link"
                  style={{ display: "block", padding: 10, marginTop: 6, width: "100%", borderRadius: 10, border: "1px solid #ddd" }}
                />
              </label>
            </div>

            <div style={{ marginTop: 10 }}>
              <label style={{ fontSize: 12, color: "#666" }}>
                Summary (optional)
                <textarea
                  value={logSummary}
                  onChange={(e) => setLogSummary(e.target.value)}
                  placeholder="Quick note about what you sent / what happened"
                  style={{ display: "block", width: "100%", minHeight: 90, padding: 10, marginTop: 6, borderRadius: 10, border: "1px solid #ddd" }}
                />
              </label>
            </div>

            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              <button
                onClick={saveTouch}
                disabled={savingTouch}
                style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
              >
                {savingTouch ? "Saving…" : "Save touch"}
              </button>
              <button
                onClick={() => setLogOpen(false)}
                style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
              >
                Cancel
              </button>
            </div>

            <div style={{ marginTop: 10, color: "#999", fontSize: 12 }}>
              Note: outbound resets cadence. inbound is tracked but doesn’t reset cadence.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}