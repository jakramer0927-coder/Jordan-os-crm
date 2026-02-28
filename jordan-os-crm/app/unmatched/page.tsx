"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";

type UnmatchedRow = {
  id: string;
  email: string;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  last_subject: string | null;
  last_snippet: string | null;
  last_thread_link: string | null;
  status: "new" | "auto_created" | "linked" | "ignored" | string;
  created_contact_id: string | null;
};

type ContactLite = {
  id: string;
  display_name: string;
  category: string;
  tier: string | null;
  email: string | null;
};

function domainOf(email: string) {
  const parts = email.split("@");
  return (parts[1] || "").toLowerCase().trim();
}

function isConsumerDomain(domain: string) {
  const consumer = new Set([
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "yahoo.co.uk",
    "icloud.com",
    "me.com",
    "mac.com",
    "hotmail.com",
    "outlook.com",
    "live.com",
    "aol.com",
    "proton.me",
    "protonmail.com",
  ]);
  return consumer.has(domain);
}

function classifyUnmatched(email: string, subject?: string | null, snippet?: string | null) {
  const d = domainOf(email);
  const text = `${subject || ""} ${snippet || ""}`.toLowerCase();

  const vendorHints = [
    "escrow",
    "title",
    "lender",
    "mortgage",
    "loan",
    "underwriting",
    "appraisal",
    "appraiser",
    "inspection",
    "inspector",
    "staging",
    "stager",
    "contractor",
    "plumber",
    "electric",
    "hvac",
    "roof",
    "pest",
    "termite",
    "photography",
    "photographer",
    "cleaning",
    "cleaner",
    "moving",
    "mover",
    "insurance",
    "warranty",
  ];

  const agentHints = [
    "dre",
    "realtor",
    "real estate",
    "broker",
    "brokerage",
    "listing",
    "offer",
    "open house",
    "showing",
    "mls",
    "compass",
    "sotheby",
    "coldwell",
    "kw",
    "keller",
    "bhhs",
    "berkshire",
    "douglas elliman",
    "the agency",
  ];

  const vendorScore =
    vendorHints.reduce((acc, k) => acc + (d.includes(k) || text.includes(k) ? 1 : 0), 0) +
    (d.includes("escrow") ? 2 : 0) +
    (d.includes("title") ? 2 : 0);

  const agentScore =
    agentHints.reduce((acc, k) => acc + (d.includes(k) || text.includes(k) ? 1 : 0), 0) +
    (d.includes("compass") ? 2 : 0);

  let label: "Likely Agent" | "Likely Vendor" | "Likely Client/Lead" | "Unclear" = "Unclear";
  let confidence = 0.55;

  if (vendorScore >= 2 && vendorScore >= agentScore + 1) {
    label = "Likely Vendor";
    confidence = Math.min(0.95, 0.62 + vendorScore * 0.08);
  } else if (agentScore >= 2 && agentScore >= vendorScore + 1) {
    label = "Likely Agent";
    confidence = Math.min(0.95, 0.62 + agentScore * 0.08);
  } else if (isConsumerDomain(d)) {
    label = "Likely Client/Lead";
    confidence = 0.68;
  } else {
    label = "Unclear";
    confidence = 0.56;
  }

  return { label, confidence };
}

function fmt(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function UnmatchedPage() {
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);

  const [rows, setRows] = useState<UnmatchedRow[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);

  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<ContactLite[]>([]);
  const [selectedContactId, setSelectedContactId] = useState<string>("");

  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    setMsg(null);

    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) {
      window.location.href = "/login";
      return;
    }
    setUid(user.id);

    const res = await fetch(`/api/unmatched/list?uid=${user.id}`);
    const j = await res.json();
    if (!res.ok) {
      setErr(j?.error || "Failed to load unmatched list");
      setReady(true);
      return;
    }

    setRows((j.rows || []) as UnmatchedRow[]);
    setReady(true);
  }

  async function ignoreEmail(email: string) {
    if (!uid) return;
    setBusy(true);
    setErr(null);
    setMsg(null);

    const res = await fetch(`/api/unmatched/ignore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, email }),
    });

    const j = await res.json();
    setBusy(false);

    if (!res.ok) {
      setErr(j?.error || "Ignore failed");
      return;
    }

    setMsg("Ignored.");
    await load();
  }

  async function createContact(email: string) {
    if (!uid) return;
    setBusy(true);
    setErr(null);
    setMsg(null);

    const res = await fetch(`/api/unmatched/create_contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, email }),
    });

    const j = await res.json();
    setBusy(false);

    if (!res.ok) {
      setErr(j?.error || "Create contact failed");
      return;
    }

    setMsg(`Created contact: ${j.display_name}`);
    await load();
  }

  async function searchContacts(q: string) {
    if (!uid) return;
    if (!q.trim()) {
      setContactResults([]);
      return;
    }

    const res = await fetch(`/api/contacts/search?uid=${uid}&q=${encodeURIComponent(q.trim())}`);
    const j = await res.json();
    if (!res.ok) {
      setContactResults([]);
      return;
    }
    setContactResults((j.results || []) as ContactLite[]);
  }

  async function linkEmail(email: string, contactId: string) {
    if (!uid) return;
    if (!contactId) {
      setErr("Pick a contact to link to.");
      return;
    }

    setBusy(true);
    setErr(null);
    setMsg(null);

    const res = await fetch(`/api/unmatched/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, email, contact_id: contactId }),
    });

    const j = await res.json();
    setBusy(false);

    if (!res.ok) {
      setErr(j?.error || "Link failed");
      return;
    }

    setMsg("Linked.");
    setSelectedEmail(null);
    setSelectedContactId("");
    setContactQuery("");
    setContactResults([]);
    await load();
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => rows.filter((r) => r.status !== "ignored"), [rows]);

  if (!ready) return <div className="page">Loading…</div>;

  const selectedRow = selectedEmail ? visible.find((r) => r.email === selectedEmail) : null;
  const selectedRec = selectedRow ? classifyUnmatched(selectedRow.email, selectedRow.last_subject, selectedRow.last_snippet) : null;

  return (
    <div className="page">
      <div className="pageHeader">
        <div>
          <h1 className="h1">Unmatched</h1>
          <div className="muted" style={{ marginTop: 8 }}>
            <span className="badge badgeGold">{visible.length} to review</span>{" "}
            <span className="badge">Gmail Sent → emails not tied to contacts yet</span>
          </div>
        </div>

        <div className="row">
          <a className="btn" href="/morning">
            Morning
          </a>
          <a className="btn" href="/contacts">
            Contacts
          </a>
          <button className="btn" onClick={load} disabled={busy}>
            Refresh
          </button>
        </div>
      </div>

      {(err || msg) && (
        <div className="card cardPad" style={{ marginTop: 14, borderColor: err ? "rgba(160,0,0,0.25)" : undefined }}>
          <div style={{ fontWeight: 900, color: err ? "#8a0000" : "#0b6b2a", whiteSpace: "pre-wrap" }}>{err || msg}</div>
        </div>
      )}

      {/* Two-column: list + action panel */}
      <div className="section" style={{ display: "grid", gridTemplateColumns: "1.25fr 0.9fr", gap: 12 }}>
        {/* Left: list */}
        <div className="stack">
          {visible.map((r) => {
            const rec = classifyUnmatched(r.email, r.last_subject, r.last_snippet);
            const isSelected = selectedEmail === r.email;

            return (
              <div
                key={r.id}
                className="card cardPad"
                style={{
                  borderColor: isSelected ? "rgba(199,167,91,0.55)" : undefined,
                  boxShadow: isSelected ? "0 18px 60px rgba(0,0,0,0.10)" : undefined,
                }}
              >
                <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 900, fontSize: 15, wordBreak: "break-word" }}>{r.email}</div>

                    <div className="row" style={{ marginTop: 10 }}>
                      <span className="badge">Seen {r.seen_count}</span>
                      <span className="badge">Last {fmt(r.last_seen_at)}</span>
                      <span className="badge">Status {r.status}</span>
                      <span className="badge badgeGold">
                        {rec.label} • {Math.round(rec.confidence * 100)}%
                      </span>
                    </div>

                    {r.last_subject ? (
                      <div style={{ marginTop: 10, lineHeight: 1.5 }}>
                        <span className="muted small bold">Subject</span>
                        <div style={{ marginTop: 4 }}>{r.last_subject}</div>
                      </div>
                    ) : null}

                    {r.last_snippet ? (
                      <div style={{ marginTop: 10, lineHeight: 1.5 }}>
                        <span className="muted small bold">Snippet</span>
                        <div style={{ marginTop: 4 }} className="muted">
                          {r.last_snippet}
                        </div>
                      </div>
                    ) : null}

                    {r.last_thread_link ? (
                      <div style={{ marginTop: 10 }}>
                        <a className="btn" href={r.last_thread_link} target="_blank" rel="noreferrer">
                          Open Gmail thread
                        </a>
                      </div>
                    ) : null}
                  </div>

                  <div style={{ width: 220, display: "grid", gap: 8 }}>
                    <button className="btn btnPrimary" onClick={() => setSelectedEmail(r.email)} disabled={busy}>
                      {isSelected ? "Selected" : "Review / Link"}
                    </button>
                    <button className="btn" onClick={() => createContact(r.email)} disabled={busy || !!r.created_contact_id}>
                      {r.created_contact_id ? "Contact created" : "Create contact"}
                    </button>
                    <button className="btn" onClick={() => ignoreEmail(r.email)} disabled={busy}>
                      Ignore
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {visible.length === 0 ? (
            <div className="card cardPad">
              <div className="muted">Nothing to review 🎉</div>
            </div>
          ) : null}
        </div>

        {/* Right: action panel */}
        <div className="card cardPad" style={{ position: "sticky", top: 14, alignSelf: "start" }}>
          <div className="sectionTitleRow" style={{ marginBottom: 8 }}>
            <div className="sectionTitle">Link workflow</div>
            <div className="sectionSub">Attach email → existing contact</div>
          </div>

          {!selectedEmail ? (
            <div className="muted" style={{ lineHeight: 1.6 }}>
              Pick an email on the left, then link it to a contact.
              <div style={{ marginTop: 10 }}>
                Tip: start with frequent internal/team addresses (ex: <span className="bold">team@…</span>) and
                decide whether they should be ignored or mapped to a “Team” contact.
              </div>
            </div>
          ) : (
            <>
              <div className="row" style={{ marginBottom: 10 }}>
                <span className="badge badgeGold">Selected</span>
                <span className="badge">{selectedEmail}</span>
              </div>

              {selectedRec ? (
                <div className="row" style={{ marginBottom: 10 }}>
                  <span className="badge">Guess</span>
                  <span className="badge badgeGold">
                    {selectedRec.label} • {Math.round(selectedRec.confidence * 100)}%
                  </span>
                </div>
              ) : null}

              <div style={{ marginTop: 10 }}>
                <div className="small muted bold" style={{ marginBottom: 6 }}>
                  Search contacts
                </div>
                <input
                  className="input"
                  value={contactQuery}
                  onChange={(e) => {
                    const v = e.target.value;
                    setContactQuery(v);
                    setSelectedContactId("");
                    searchContacts(v);
                  }}
                  placeholder="Search by name (e.g., 'Brad' or 'Ray')"
                />
              </div>

              <div style={{ marginTop: 10 }}>
                <div className="small muted bold" style={{ marginBottom: 6 }}>
                  Select contact
                </div>
                <select className="select" value={selectedContactId} onChange={(e) => setSelectedContactId(e.target.value)}>
                  <option value="">Select a contact…</option>
                  {contactResults.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.display_name} • {c.category}
                      {c.tier ? ` • ${c.tier}` : ""}
                      {c.email ? ` • ${c.email}` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
                <button
                  className="btn"
                  onClick={() => {
                    setSelectedEmail(null);
                    setSelectedContactId("");
                    setContactQuery("");
                    setContactResults([]);
                  }}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button className="btn btnPrimary" onClick={() => linkEmail(selectedEmail, selectedContactId)} disabled={busy || !selectedContactId}>
                  Link
                </button>
              </div>

              <div className="muted small" style={{ marginTop: 12, lineHeight: 1.5 }}>
                Linking will: (1) add this email to <code>contact_emails</code>, (2) mark unmatched as <code>linked</code>.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}