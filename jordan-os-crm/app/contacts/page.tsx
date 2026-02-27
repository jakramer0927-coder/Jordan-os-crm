"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";

type TouchIntent =
  | "check_in"
  | "referral_ask"
  | "review_ask"
  | "deal_followup"
  | "collaboration"
  | "event_invite"
  | "other";

type ContactEmail = {
  email: string;
  is_primary: boolean;
};

type Contact = {
  id: string;
  display_name: string;
  category: string;
  tier: string | null;
  client_type: string | null;
  created_at: string;
  contact_emails?: ContactEmail[] | null;
};

type Touch = {
  id: string;
  contact_id: string;
  channel: "email" | "text" | "call" | "in_person" | "social_dm" | "other";
  direction: "outbound" | "inbound";
  occurred_at: string;
  summary: string | null;
  source: string | null;
  source_link: string | null;
  intent: TouchIntent | null;
};

type ContactWithLastTouch = Contact & {
  primary_email: string | null;
  last_touch_at: string | null;
  last_touch_channel: Touch["channel"] | null;
  days_since_touch: number | null;
};

function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(0, days);
}

function pickPrimaryEmail(emails?: ContactEmail[] | null): string | null {
  if (!emails || emails.length === 0) return null;
  const primary = emails.find((e) => e.is_primary);
  return (primary?.email || emails[0]?.email || "").trim() || null;
}

export default function ContactsPage() {
  const [ready, setReady] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const [contacts, setContacts] = useState<ContactWithLastTouch[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Create contact form
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Client");
  const [tier, setTier] = useState<"A" | "B" | "C">("A");
  const [clientType, setClientType] = useState("");
  const [email, setEmail] = useState("");
  const [addingContact, setAddingContact] = useState(false);

  // Log touch form state (per contact)
  const [touchChannel, setTouchChannel] = useState<Touch["channel"]>("text");
  const [touchDirection, setTouchDirection] = useState<Touch["direction"]>("outbound");
  const [touchIntent, setTouchIntent] = useState<TouchIntent>("check_in");
  const [touchSummary, setTouchSummary] = useState("");
  const [touchSource, setTouchSource] = useState("manual");
  const [touchLink, setTouchLink] = useState("");
  const [loggingFor, setLoggingFor] = useState<string | null>(null);
  const [loggingTouch, setLoggingTouch] = useState(false);

  async function fetchContactsWithLastTouch() {
    setError(null);

    // 1) Fetch contacts (with emails)
    const { data: cData, error: cErr } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, client_type, created_at, contact_emails(email, is_primary)")
      .order("created_at", { ascending: false })
      .limit(500);

    if (cErr) {
      setError(`Contacts fetch error: ${cErr.message}`);
      setContacts([]);
      return;
    }

    const baseContacts = (cData ?? []) as Contact[];

    if (baseContacts.length === 0) {
      setContacts([]);
      return;
    }

    // 2) Fetch latest touches for these contacts (any direction/channel)
    const contactIds = baseContacts.map((c) => c.id);

    const { data: tData, error: tErr } = await supabase
      .from("touches")
      .select("id, contact_id, channel, direction, occurred_at, summary, source, source_link, intent")
      .in("contact_id", contactIds)
      .order("occurred_at", { ascending: false })
      .limit(4000);

    if (tErr) {
      setError(`Touches fetch error: ${tErr.message}`);
      const merged: ContactWithLastTouch[] = baseContacts.map((c) => ({
        ...c,
        primary_email: pickPrimaryEmail(c.contact_emails),
        last_touch_at: null,
        last_touch_channel: null,
        days_since_touch: null,
      }));
      setContacts(merged);
      return;
    }

    const touches = (tData ?? []) as Touch[];

    const latestByContact = new Map<string, Touch>();
    for (const t of touches) {
      if (!latestByContact.has(t.contact_id)) latestByContact.set(t.contact_id, t);
    }

    const merged: ContactWithLastTouch[] = baseContacts.map((c) => {
      const last = latestByContact.get(c.id) ?? null;
      return {
        ...c,
        primary_email: pickPrimaryEmail(c.contact_emails),
        last_touch_at: last ? last.occurred_at : null,
        last_touch_channel: last ? last.channel : null,
        days_since_touch: last ? daysSince(last.occurred_at) : null,
      };
    });

    // Sort: oldest touch first (nulls last)
    merged.sort((a, b) => {
      const ad = a.days_since_touch ?? -1;
      const bd = b.days_since_touch ?? -1;
      if (ad === -1 && bd === -1) return 0;
      if (ad === -1) return 1;
      if (bd === -1) return -1;
      return bd - ad;
    });

    setContacts(merged);
  }

  async function addContact() {
    if (!name.trim()) return;
    setAddingContact(true);
    setError(null);

    const { data: s } = await supabase.auth.getSession();
    if (!s.session) {
      window.location.href = "/login";
      return;
    }

    const { data: inserted, error: insErr } = await supabase
      .from("contacts")
      .insert({
        display_name: name.trim(),
        category,
        tier,
        client_type: clientType.trim() ? clientType.trim() : null,
      })
      .select("id")
      .single();

    if (insErr || !inserted?.id) {
      setAddingContact(false);
      setError(`Insert contact error: ${insErr?.message || "Unknown insert error"}`);
      return;
    }

    const cleanEmail = email.trim().toLowerCase();
    if (cleanEmail) {
      const { error: eErr } = await supabase.from("contact_emails").insert({
        contact_id: inserted.id,
        email: cleanEmail,
        is_primary: true,
      });

      if (eErr) {
        // Don't fail the whole add — just report
        setError(`Contact created, but email insert failed: ${eErr.message}`);
      }
    }

    setAddingContact(false);

    setName("");
    setEmail("");
    setClientType("");
    await fetchContactsWithLastTouch();
  }

  function openLogTouch(contactId: string) {
    setLoggingFor(contactId);
    setTouchChannel("text");
    setTouchDirection("outbound");
    setTouchIntent("check_in");
    setTouchSummary("");
    setTouchSource("manual");
    setTouchLink("");
  }

  async function saveTouch() {
    if (!loggingFor) return;
    setLoggingTouch(true);
    setError(null);

    const occurredAt = new Date().toISOString();

    const { error } = await supabase.from("touches").insert({
      contact_id: loggingFor,
      channel: touchChannel,
      direction: touchDirection,
      intent: touchIntent,
      occurred_at: occurredAt,
      summary: touchSummary.trim() ? touchSummary.trim() : null,
      source: touchSource.trim() ? touchSource.trim() : null,
      source_link: touchLink.trim() ? touchLink.trim() : null,
    });

    setLoggingTouch(false);

    if (error) {
      setError(`Insert touch error: ${error.message}`);
      return;
    }

    setLoggingFor(null);
    await fetchContactsWithLastTouch();
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user?.id ?? null;
      if (!mounted) return;

      if (!uid) {
        setTimeout(async () => {
          const { data: d2 } = await supabase.auth.getSession();
          if (!d2.session) window.location.href = "/login";
        }, 250);
        return;
      }

      setUserId(uid);
      setReady(true);
      await fetchContactsWithLastTouch();
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const uid = session?.user?.id ?? null;
      setUserId(uid);
      setReady(!!uid);
      if (!uid) window.location.href = "/login";
    });

    init();

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) return <div style={{ padding: 40 }}>Loading…</div>;

  return (
    <div style={{ padding: 40, maxWidth: 1100 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0 }}>Contacts</h1>
          <div style={{ marginTop: 6, color: "#666" }}>
            Logged in ✅ {userId ? `(user ${userId.slice(0, 8)}…)` : ""} • Loaded:{" "}
            <strong>{contacts.length}</strong>
          </div>
        </div>
        <button
          onClick={signOut}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
        >
          Sign out
        </button>
      </div>

      {/* Add contact */}
      <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          style={{ padding: 10, width: 280, borderRadius: 10, border: "1px solid #ddd" }}
        />

        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Primary email (optional)"
          style={{ padding: 10, width: 260, borderRadius: 10, border: "1px solid #ddd" }}
        />

        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ padding: 10 }}>
          <option>Client</option>
          <option>Agent</option>
          <option>Developer</option>
          <option>Vendor</option>
          <option>Other</option>
        </select>

        <select value={tier} onChange={(e) => setTier(e.target.value as any)} style={{ padding: 10 }}>
          <option value="A">A</option>
          <option value="B">B</option>
          <option value="C">C</option>
        </select>

        <input
          value={clientType}
          onChange={(e) => setClientType(e.target.value)}
          placeholder="Client type (optional)"
          style={{ padding: 10, width: 220, borderRadius: 10, border: "1px solid #ddd" }}
        />

        <button
          onClick={addContact}
          disabled={addingContact}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
        >
          {addingContact ? "Adding…" : "Add contact"}
        </button>

        <button
          onClick={fetchContactsWithLastTouch}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
        >
          Refresh
        </button>
      </div>

      {error && <div style={{ marginTop: 14, color: "crimson", fontWeight: 800 }}>{error}</div>}

      <div style={{ marginTop: 18 }}>
        {contacts.map((c) => (
          <div
            key={c.id}
            style={{
              border: "1px solid #e5e5e5",
              borderRadius: 12,
              padding: 12,
              marginBottom: 10,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16 }}>
                  <a href={`/contacts/${c.id}`} style={{ color: "#111", textDecoration: "none" }}>
                    {c.display_name}
                  </a>
                </div>
                <div style={{ color: "#555", marginTop: 4 }}>
                  {c.category} {c.tier ? `• Tier ${c.tier}` : ""} {c.client_type ? `• ${c.client_type}` : ""}
                </div>
                <div style={{ color: "#777", marginTop: 6, fontSize: 13 }}>
                  {c.primary_email ? (
                    <>
                      Email: <strong>{c.primary_email}</strong> •{" "}
                    </>
                  ) : null}
                  Last touch: <strong>{c.last_touch_at ? new Date(c.last_touch_at).toLocaleString() : "—"}</strong>
                  {c.last_touch_channel ? ` • ${c.last_touch_channel}` : ""}
                  {typeof c.days_since_touch === "number" ? ` • ${c.days_since_touch}d ago` : ""}
                </div>
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <a
                  href={`/contacts/${c.id}`}
                  style={{
                    padding: "10px 14px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    cursor: "pointer",
                    textDecoration: "none",
                    color: "#111",
                    fontWeight: 900,
                  }}
                >
                  View
                </a>
                <button
                  onClick={() => openLogTouch(c.id)}
                  style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
                >
                  Log touch
                </button>
              </div>
            </div>

            {loggingFor === c.id && (
              <div
                style={{
                  marginTop: 12,
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid #ddd",
                  background: "#fafafa",
                }}
              >
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <select value={touchChannel} onChange={(e) => setTouchChannel(e.target.value as any)} style={{ padding: 10 }}>
                    <option value="email">email</option>
                    <option value="text">text</option>
                    <option value="call">call</option>
                    <option value="in_person">in_person</option>
                    <option value="social_dm">social_dm</option>
                    <option value="other">other</option>
                  </select>

                  <select
                    value={touchDirection}
                    onChange={(e) => setTouchDirection(e.target.value as any)}
                    style={{ padding: 10 }}
                  >
                    <option value="outbound">outbound</option>
                    <option value="inbound">inbound</option>
                  </select>

                  <select value={touchIntent} onChange={(e) => setTouchIntent(e.target.value as any)} style={{ padding: 10 }}>
                    <option value="check_in">check_in</option>
                    <option value="referral_ask">referral_ask</option>
                    <option value="review_ask">review_ask</option>
                    <option value="deal_followup">deal_followup</option>
                    <option value="collaboration">collaboration</option>
                    <option value="event_invite">event_invite</option>
                    <option value="other">other</option>
                  </select>

                  <input
                    value={touchSource}
                    onChange={(e) => setTouchSource(e.target.value)}
                    placeholder="source (gmail, sms, manual)"
                    style={{ padding: 10, width: 220, borderRadius: 10, border: "1px solid #ddd" }}
                  />

                  <input
                    value={touchLink}
                    onChange={(e) => setTouchLink(e.target.value)}
                    placeholder="source link (optional)"
                    style={{ padding: 10, width: 360, borderRadius: 10, border: "1px solid #ddd" }}
                  />
                </div>

                <textarea
                  value={touchSummary}
                  onChange={(e) => setTouchSummary(e.target.value)}
                  placeholder="Summary (optional)"
                  style={{
                    marginTop: 10,
                    width: "100%",
                    padding: 10,
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    minHeight: 70,
                  }}
                />

                <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
                  <button
                    onClick={saveTouch}
                    disabled={loggingTouch}
                    style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
                  >
                    {loggingTouch ? "Saving…" : "Save touch"}
                  </button>

                  <button
                    onClick={() => setLoggingFor(null)}
                    style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}