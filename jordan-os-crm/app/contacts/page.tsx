"use client";

import { useEffect, useState } from "react";
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
  created_at: string;
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

export default function ContactsPage() {
  const [ready, setReady] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const [contacts, setContacts] = useState<ContactWithLastTouch[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Create contact form
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Client");
  const [tier, setTier] = useState<"A" | "B" | "C">("A");
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

    const { data: cData, error: cErr } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, created_at")
      .order("created_at", { ascending: false })
      .limit(200);

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

    const contactIds = baseContacts.map((c) => c.id);

    const { data: tData, error: tErr } = await supabase
      .from("touches")
      .select("id, contact_id, channel, direction, occurred_at, summary, source, source_link, intent")
      .in("contact_id", contactIds)
      .order("occurred_at", { ascending: false })
      .limit(2000);

    if (tErr) {
      setError(`Touches fetch error: ${tErr.message}`);
      const merged: ContactWithLastTouch[] = baseContacts.map((c) => ({
        ...c,
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
        last_touch_at: last ? last.occurred_at : null,
        last_touch_channel: last ? last.channel : null,
        days_since_touch: last ? daysSince(last.occurred_at) : null,
      };
    });

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

    const { error } = await supabase.from("contacts").insert({
      display_name: name.trim(),
      category,
      tier,
    });

    setAddingContact(false);

    if (error) {
      setError(`Insert contact error: ${error.message}`);
      return;
    }

    setName("");
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

  if (!ready) return <div className="card cardPad">Loading…</div>;

  return (
    <div className="stack">
      <div className="rowBetween">
        <div>
          <h1 className="h1">Contacts</h1>
          <div className="subtle" style={{ marginTop: 6 }}>
            Logged in ✅ {userId ? `(user ${userId.slice(0, 8)}…)` : ""} • Loaded: <strong>{contacts.length}</strong>
          </div>
        </div>

        <button className="btn" onClick={signOut}>
          Sign out
        </button>
      </div>

      <div className="card cardPad">
        <div className="row">
          <div className="field" style={{ width: 320, minWidth: 240 }}>
            <div className="label">Name</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
          </div>

          <div className="field" style={{ width: 200, minWidth: 180 }}>
            <div className="label">Category</div>
            <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option>Client</option>
              <option>Agent</option>
              <option>Developer</option>
              <option>Vendor</option>
              <option>Other</option>
            </select>
          </div>

          <div className="field" style={{ width: 140, minWidth: 120 }}>
            <div className="label">Tier</div>
            <select className="select" value={tier} onChange={(e) => setTier(e.target.value as any)}>
              <option value="A">A</option>
              <option value="B">B</option>
              <option value="C">C</option>
            </select>
          </div>

          <button className="btn btnPrimary" onClick={addContact} disabled={addingContact}>
            {addingContact ? "Adding…" : "Add contact"}
          </button>

          <button className="btn" onClick={fetchContactsWithLastTouch}>
            Refresh
          </button>
        </div>

        {error && <div className="alert alertError" style={{ marginTop: 12 }}>{error}</div>}
      </div>

      <div className="stack">
        {contacts.map((c) => (
          <div key={c.id} className="card cardPad">
            <div className="rowBetween">
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 900, fontSize: 16 }}>
                  <a href={`/contacts/${c.id}`} style={{ textDecoration: "none" }}>
                    {c.display_name}
                  </a>
                </div>

                <div className="subtle" style={{ marginTop: 6 }}>
                  <span className="badge">{c.category}</span>{" "}
                  {c.tier ? <span className="badge">Tier {c.tier}</span> : null}
                  {c.last_touch_channel ? <span className="badge">{c.last_touch_channel}</span> : null}
                  {typeof c.days_since_touch === "number" ? <span className="badge">{c.days_since_touch}d</span> : null}
                </div>

                <div className="subtle" style={{ marginTop: 8, fontSize: 13 }}>
                  Last touch:{" "}
                  <strong>{c.last_touch_at ? new Date(c.last_touch_at).toLocaleString() : "—"}</strong>
                </div>
              </div>

              <div className="row">
                <button className="btn" onClick={() => openLogTouch(c.id)}>
                  Log touch
                </button>
                <a className="btn" href={`/contacts/${c.id}`} style={{ textDecoration: "none" }}>
                  Open
                </a>
              </div>
            </div>

            {loggingFor === c.id && (
              <div className="card cardPad" style={{ marginTop: 12, background: "rgba(247,244,238,.5)" }}>
                <div className="row">
                  <div className="field" style={{ width: 160 }}>
                    <div className="label">Channel</div>
                    <select className="select" value={touchChannel} onChange={(e) => setTouchChannel(e.target.value as any)}>
                      <option value="email">email</option>
                      <option value="text">text</option>
                      <option value="call">call</option>
                      <option value="in_person">in_person</option>
                      <option value="social_dm">social_dm</option>
                      <option value="other">other</option>
                    </select>
                  </div>

                  <div className="field" style={{ width: 160 }}>
                    <div className="label">Direction</div>
                    <select className="select" value={touchDirection} onChange={(e) => setTouchDirection(e.target.value as any)}>
                      <option value="outbound">outbound</option>
                      <option value="inbound">inbound</option>
                    </select>
                  </div>

                  <div className="field" style={{ width: 200 }}>
                    <div className="label">Intent</div>
                    <select className="select" value={touchIntent} onChange={(e) => setTouchIntent(e.target.value as any)}>
                      <option value="check_in">check_in</option>
                      <option value="referral_ask">referral_ask</option>
                      <option value="review_ask">review_ask</option>
                      <option value="deal_followup">deal_followup</option>
                      <option value="collaboration">collaboration</option>
                      <option value="event_invite">event_invite</option>
                      <option value="other">other</option>
                    </select>
                  </div>

                  <div className="field" style={{ flex: 1, minWidth: 220 }}>
                    <div className="label">Source</div>
                    <input className="input" value={touchSource} onChange={(e) => setTouchSource(e.target.value)} placeholder="manual / gmail / sms" />
                  </div>

                  <div className="field" style={{ flex: 1, minWidth: 260 }}>
                    <div className="label">Link (optional)</div>
                    <input className="input" value={touchLink} onChange={(e) => setTouchLink(e.target.value)} placeholder="thread link / calendar link" />
                  </div>
                </div>

                <div className="field" style={{ marginTop: 10 }}>
                  <div className="label">Summary (optional)</div>
                  <textarea className="textarea" value={touchSummary} onChange={(e) => setTouchSummary(e.target.value)} placeholder="Quick note about what happened" />
                </div>

                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn btnPrimary" onClick={saveTouch} disabled={loggingTouch}>
                    {loggingTouch ? "Saving…" : "Save touch"}
                  </button>
                  <button className="btn" onClick={() => setLoggingFor(null)}>
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