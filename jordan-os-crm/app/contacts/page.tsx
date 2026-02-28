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
  summary: string | null;
  source: string | null;
  source_link: string | null;
  intent: TouchIntent | null;
};

type ContactWithLastTouch = Contact & {
  last_touch_at: string | null;
  last_touch_channel: Touch["channel"] | null;
  last_touch_direction: Touch["direction"] | null;
  days_since_touch: number | null;
};

function daysSince(iso: string): number {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return Math.max(0, days);
}

function fmtWhen(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function pretty(s: string | null | undefined) {
  const v = (s || "").trim();
  return v ? v : "—";
}

export default function ContactsPage() {
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);

  const [contacts, setContacts] = useState<ContactWithLastTouch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // UI state
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("All");
  const [tierFilter, setTierFilter] = useState<string>("All");
  const [showOnlyOverdue, setShowOnlyOverdue] = useState(false);

  // Create contact form
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Client");
  const [tier, setTier] = useState<"A" | "B" | "C">("A");
  const [clientType, setClientType] = useState("");
  const [email, setEmail] = useState("");

  const [addingContact, setAddingContact] = useState(false);

  // Log touch drawer
  const [loggingFor, setLoggingFor] = useState<string | null>(null);
  const [touchChannel, setTouchChannel] = useState<Touch["channel"]>("text");
  const [touchDirection, setTouchDirection] = useState<Touch["direction"]>("outbound");
  const [touchIntent, setTouchIntent] = useState<TouchIntent>("check_in");
  const [touchSummary, setTouchSummary] = useState("");
  const [touchSource, setTouchSource] = useState("manual");
  const [touchLink, setTouchLink] = useState("");
  const [loggingTouch, setLoggingTouch] = useState(false);

  function cadenceDaysFor(c: ContactWithLastTouch): number | null {
    const cat = (c.category || "").toLowerCase();
    const tier = (c.tier || "").toUpperCase();

    // Your stated defaults:
    // Clients: A 30, B 60, C 90
    // Agents: A 30 (we'll treat tier A only), others fall back 60
    // Developers: 60
    if (cat === "client") {
      if (tier === "A") return 30;
      if (tier === "B") return 60;
      if (tier === "C") return 90;
      return 60;
    }
    if (cat === "agent") {
      if (tier === "A") return 30;
      return 60;
    }
    if (cat === "developer") return 60;

    // Default cadence (safe)
    return 60;
  }

  function isOverdue(c: ContactWithLastTouch): boolean {
    const cadence = cadenceDaysFor(c);
    if (!cadence) return false;
    if (c.days_since_touch == null) return true; // never touched -> treat as overdue
    return c.days_since_touch >= cadence;
  }

  async function requireSession() {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user ?? null;
    if (!user) {
      window.location.href = "/login";
      return null;
    }
    setUid(user.id);
    return user;
  }

  async function fetchContactsWithLastTouch() {
    setError(null);
    setMsg(null);
    setLoading(true);

    const user = await requireSession();
    if (!user) return;

    // 1) contacts
    const { data: cData, error: cErr } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, client_type, email, created_at")
      .order("created_at", { ascending: false })
      .limit(2000);

    if (cErr) {
      setError(`Contacts fetch error: ${cErr.message}`);
      setContacts([]);
      setLoading(false);
      return;
    }

    const base = (cData ?? []) as Contact[];
    if (base.length === 0) {
      setContacts([]);
      setLoading(false);
      return;
    }

    // 2) latest touches for those contacts
    const ids = base.map((c) => c.id);

    const { data: tData, error: tErr } = await supabase
      .from("touches")
      .select("id, contact_id, channel, direction, occurred_at, summary, source, source_link, intent")
      .in("contact_id", ids)
      .order("occurred_at", { ascending: false })
      .limit(8000);

    if (tErr) {
      // Still show contacts without last touch info
      const mergedFail: ContactWithLastTouch[] = base.map((c) => ({
        ...c,
        last_touch_at: null,
        last_touch_channel: null,
        last_touch_direction: null,
        days_since_touch: null,
      }));
      setContacts(mergedFail);
      setError(`Touches fetch error: ${tErr.message}`);
      setLoading(false);
      return;
    }

    const touches = (tData ?? []) as Touch[];
    const latestByContact = new Map<string, Touch>();
    for (const t of touches) {
      if (!latestByContact.has(t.contact_id)) latestByContact.set(t.contact_id, t);
    }

    const merged: ContactWithLastTouch[] = base.map((c) => {
      const last = latestByContact.get(c.id) ?? null;
      return {
        ...c,
        last_touch_at: last ? last.occurred_at : null,
        last_touch_channel: last ? last.channel : null,
        last_touch_direction: last ? last.direction : null,
        days_since_touch: last ? daysSince(last.occurred_at) : null,
      };
    });

    // Sort: overdue first (then longest since touch)
    merged.sort((a, b) => {
      const ao = isOverdue(a) ? 1 : 0;
      const bo = isOverdue(b) ? 1 : 0;
      if (ao !== bo) return bo - ao;

      const ad = a.days_since_touch ?? -1;
      const bd = b.days_since_touch ?? -1;
      if (ad === -1 && bd === -1) return 0;
      if (ad === -1) return 1;
      if (bd === -1) return -1;
      return bd - ad;
    });

    setContacts(merged);
    setLoading(false);
  }

  async function addContact() {
    setError(null);
    setMsg(null);

    const n = name.trim();
    if (!n) {
      setError("Name is required.");
      return;
    }

    setAddingContact(true);

    const user = await requireSession();
    if (!user) return;

    const { error: insErr } = await supabase.from("contacts").insert({
      display_name: n,
      category,
      tier,
      client_type: clientType.trim() ? clientType.trim() : null,
      email: email.trim() ? email.trim().toLowerCase() : null,
    });

    setAddingContact(false);

    if (insErr) {
      setError(`Insert contact error: ${insErr.message}`);
      return;
    }

    setName("");
    setClientType("");
    setEmail("");
    setMsg("Contact added.");
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
    setMsg(null);

    const { error: insErr } = await supabase.from("touches").insert({
      contact_id: loggingFor,
      channel: touchChannel,
      direction: touchDirection,
      intent: touchIntent,
      occurred_at: new Date().toISOString(),
      summary: touchSummary.trim() ? touchSummary.trim() : null,
      source: touchSource.trim() ? touchSource.trim() : null,
      source_link: touchLink.trim() ? touchLink.trim() : null,
    });

    setLoggingTouch(false);

    if (insErr) {
      setError(`Insert touch error: ${insErr.message}`);
      return;
    }

    setLoggingFor(null);
    setMsg("Touch saved.");
    await fetchContactsWithLastTouch();
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  useEffect(() => {
    let alive = true;

    const init = async () => {
      const user = await requireSession();
      if (!alive) return;
      if (!user) return;

      setReady(true);
      await fetchContactsWithLastTouch();
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const u = session?.user ?? null;
      if (!u) window.location.href = "/login";
    });

    init();

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return contacts.filter((c) => {
      if (categoryFilter !== "All" && (c.category || "") !== categoryFilter) return false;
      if (tierFilter !== "All" && (c.tier || "") !== tierFilter) return false;
      if (showOnlyOverdue && !isOverdue(c)) return false;

      if (!q) return true;
      const hay = `${c.display_name} ${c.category} ${c.tier || ""} ${c.client_type || ""} ${c.email || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [contacts, search, categoryFilter, tierFilter, showOnlyOverdue]);

  const stats = useMemo(() => {
    const overdue = contacts.filter((c) => isOverdue(c)).length;
    const aClientsOverdue = contacts.filter((c) => (c.category || "").toLowerCase() === "client" && (c.tier || "").toUpperCase() === "A" && isOverdue(c)).length;
    return { total: contacts.length, overdue, aClientsOverdue, shown: filtered.length };
  }, [contacts, filtered]);

  if (!ready) return <div className="page">Loading…</div>;

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="h1">Contacts</h1>
          <div className="muted" style={{ marginTop: 8 }}>
            <span className="badge">{stats.total} total</span>{" "}
            <span className="badge">{stats.overdue} overdue</span>{" "}
            <span className="badge">{stats.aClientsOverdue} A-clients overdue</span>{" "}
            <span className="badge">{stats.shown} shown</span>
          </div>
        </div>

        <div className="row">
          <button className="btn" onClick={fetchContactsWithLastTouch} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button className="btn" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      {(error || msg) && (
        <div className="card cardPad" style={{ borderColor: error ? "rgba(160,0,0,0.25)" : undefined }}>
          <div style={{ fontWeight: 900, color: error ? "#8a0000" : "#0b6b2a", whiteSpace: "pre-wrap" }}>
            {error || msg}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="section" style={{ marginTop: 14 }}>
        <div className="sectionTitleRow">
          <div className="sectionTitle">Filter & Search</div>
          <div className="sectionSub">Find people fast. Prioritize overdue.</div>
        </div>

        <div className="row">
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="small muted bold" style={{ marginBottom: 6 }}>
              Search
            </div>
            <input
              className="input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, email, client type, category…"
            />
          </div>

          <div style={{ width: 200, minWidth: 180 }}>
            <div className="small muted bold" style={{ marginBottom: 6 }}>
              Category
            </div>
            <select className="select" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="All">All</option>
              <option value="Client">Client</option>
              <option value="Agent">Agent</option>
              <option value="Developer">Developer</option>
              <option value="Vendor">Vendor</option>
              <option value="Other">Other</option>
            </select>
          </div>

          <div style={{ width: 160, minWidth: 140 }}>
            <div className="small muted bold" style={{ marginBottom: 6 }}>
              Tier
            </div>
            <select className="select" value={tierFilter} onChange={(e) => setTierFilter(e.target.value)}>
              <option value="All">All</option>
              <option value="A">A</option>
              <option value="B">B</option>
              <option value="C">C</option>
            </select>
          </div>

          <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
            <button className={showOnlyOverdue ? "btn btnPrimary" : "btn"} onClick={() => setShowOnlyOverdue((v) => !v)}>
              {showOnlyOverdue ? "Overdue only" : "Show overdue"}
            </button>
            <button
              className="btn"
              onClick={() => {
                setSearch("");
                setCategoryFilter("All");
                setTierFilter("All");
                setShowOnlyOverdue(false);
              }}
            >
              Reset
            </button>
          </div>
        </div>
      </div>

      {/* Add contact */}
      <div className="section" style={{ marginTop: 12 }}>
        <div className="sectionTitleRow">
          <div className="sectionTitle">Add contact</div>
          <div className="sectionSub">Quick entry. You can refine later on the contact detail page.</div>
        </div>

        <div className="row">
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="small muted bold" style={{ marginBottom: 6 }}>
              Name
            </div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
          </div>

          <div style={{ width: 200, minWidth: 180 }}>
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

          <div style={{ width: 160, minWidth: 140 }}>
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

        <div className="row" style={{ marginTop: 10 }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="small muted bold" style={{ marginBottom: 6 }}>
              Client type (optional)
            </div>
            <input
              className="input"
              value={clientType}
              onChange={(e) => setClientType(e.target.value)}
              placeholder="buyer / seller / past_client / lead / landlord / tenant / sphere…"
            />
          </div>

          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="small muted bold" style={{ marginBottom: 6 }}>
              Email (optional)
            </div>
            <input
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@email.com"
            />
          </div>

          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button className="btn btnPrimary" onClick={addContact} disabled={addingContact}>
              {addingContact ? "Adding…" : "Add"}
            </button>
          </div>
        </div>
      </div>

      {/* Results */}
      <div style={{ marginTop: 14 }} className="stack">
        {filtered.map((c) => {
          const overdue = isOverdue(c);
          const cadence = cadenceDaysFor(c);
          return (
            <div key={c.id} className="card cardPad">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
                    <div style={{ fontWeight: 900, fontSize: 16, wordBreak: "break-word" }}>
                      <a href={`/contacts/${c.id}`}>{c.display_name}</a>
                    </div>
                    <div className="muted small">
                      {c.last_touch_at ? `Last touch ${fmtWhen(c.last_touch_at)}` : "No touches yet"}
                    </div>
                  </div>

                  <div className="row" style={{ marginTop: 10 }}>
                    <span className="badge">{pretty(c.category)}</span>
                    {c.tier ? <span className="badge">Tier {c.tier}</span> : <span className="badge">Tier —</span>}
                    {c.client_type ? <span className="badge">{c.client_type}</span> : null}
                    {c.email ? <span className="badge">{c.email}</span> : null}

                    {typeof cadence === "number" ? <span className="badge">Cadence {cadence}d</span> : null}
                    {typeof c.days_since_touch === "number" ? <span className="badge">{c.days_since_touch}d since</span> : <span className="badge">Never touched</span>}

                    {overdue ? <span className="badge">Overdue</span> : <span className="badge">On track</span>}
                    {c.last_touch_channel ? <span className="badge">{c.last_touch_channel}</span> : null}
                    {c.last_touch_direction ? <span className="badge">{c.last_touch_direction}</span> : null}
                  </div>
                </div>

                <div style={{ width: 260, display: "grid", gap: 10 }}>
                  <a className="btn" href={`/contacts/${c.id}`}>
                    Open
                  </a>

                  <button className="btn btnPrimary" onClick={() => openLogTouch(c.id)}>
                    Log touch
                  </button>
                </div>
              </div>

              {/* Log touch drawer inside card */}
              {loggingFor === c.id && (
                <div className="cardSoft cardPad" style={{ marginTop: 12 }}>
                  <div className="sectionTitleRow" style={{ marginBottom: 8 }}>
                    <div className="sectionTitle">Log touch</div>
                    <div className="sectionSub">{c.display_name}</div>
                  </div>

                  <div className="row">
                    <div style={{ width: 180, minWidth: 160 }}>
                      <div className="small muted bold" style={{ marginBottom: 6 }}>
                        Channel
                      </div>
                      <select className="select" value={touchChannel} onChange={(e) => setTouchChannel(e.target.value as any)}>
                        <option value="email">email</option>
                        <option value="text">text</option>
                        <option value="call">call</option>
                        <option value="in_person">in_person</option>
                        <option value="social_dm">social_dm</option>
                        <option value="other">other</option>
                      </select>
                    </div>

                    <div style={{ width: 180, minWidth: 160 }}>
                      <div className="small muted bold" style={{ marginBottom: 6 }}>
                        Direction
                      </div>
                      <select className="select" value={touchDirection} onChange={(e) => setTouchDirection(e.target.value as any)}>
                        <option value="outbound">outbound</option>
                        <option value="inbound">inbound</option>
                      </select>
                    </div>

                    <div style={{ width: 220, minWidth: 200 }}>
                      <div className="small muted bold" style={{ marginBottom: 6 }}>
                        Intent
                      </div>
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

                    <div style={{ flex: 1, minWidth: 220 }}>
                      <div className="small muted bold" style={{ marginBottom: 6 }}>
                        Source
                      </div>
                      <input
                        className="input"
                        value={touchSource}
                        onChange={(e) => setTouchSource(e.target.value)}
                        placeholder="manual / gmail / sms"
                      />
                    </div>
                  </div>

                  <div className="row" style={{ marginTop: 10 }}>
                    <div style={{ flex: 1, minWidth: 260 }}>
                      <div className="small muted bold" style={{ marginBottom: 6 }}>
                        Link (optional)
                      </div>
                      <input
                        className="input"
                        value={touchLink}
                        onChange={(e) => setTouchLink(e.target.value)}
                        placeholder="thread link / calendar link"
                      />
                    </div>
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <div className="small muted bold" style={{ marginBottom: 6 }}>
                      Summary (optional)
                    </div>
                    <textarea
                      className="textarea"
                      value={touchSummary}
                      onChange={(e) => setTouchSummary(e.target.value)}
                      placeholder="Quick note about what happened"
                    />
                  </div>

                  <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
                    <div className="muted small">
                      Note: outbound resets cadence. inbound is tracked but doesn’t reset cadence.
                    </div>
                    <div className="row">
                      <button className="btn" onClick={() => setLoggingFor(null)} disabled={loggingTouch}>
                        Cancel
                      </button>
                      <button className="btn btnPrimary" onClick={saveTouch} disabled={loggingTouch}>
                        {loggingTouch ? "Saving…" : "Save touch"}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 ? (
          <div className="card cardPad">
            <div className="muted">No contacts match your filters.</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}