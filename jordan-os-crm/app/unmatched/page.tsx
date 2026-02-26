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
  let confidence = 0.5;

  if (vendorScore >= 2 && vendorScore >= agentScore + 1) {
    label = "Likely Vendor";
    confidence = Math.min(0.95, 0.6 + vendorScore * 0.08);
  } else if (agentScore >= 2 && agentScore >= vendorScore + 1) {
    label = "Likely Agent";
    confidence = Math.min(0.95, 0.6 + agentScore * 0.08);
  } else if (isConsumerDomain(d)) {
    label = "Likely Client/Lead";
    confidence = 0.65;
  } else {
    label = "Unclear";
    confidence = 0.55;
  }

  return { label, confidence };
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

  const visible = useMemo(() => {
    // Hide ignored by default
    return rows.filter((r) => r.status !== "ignored");
  }, [rows]);

  if (!ready) return <div style={{ padding: 40 }}>Loading…</div>;

  return (
    <div style={{ padding: 40, maxWidth: 1100 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 900 }}>/unmatched</h1>
          <div style={{ marginTop: 6, color: "#666" }}>
            Review emails found in Sent that aren’t tied to your CRM yet.{" "}
            <strong>{visible.length}</strong> items.
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <a
            href="/morning"
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              textDecoration: "none",
              color: "#111",
            }}
          >
            Morning
          </a>
          <a
            href="/contacts"
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              textDecoration: "none",
              color: "#111",
            }}
          >
            Contacts
          </a>
          <button
            onClick={load}
            disabled={busy}
            style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
          >
            Refresh
          </button>
        </div>
      </div>

      {(err || msg) && (
        <div style={{ marginTop: 14, color: err ? "crimson" : "green", fontWeight: 800, whiteSpace: "pre-wrap" }}>
          {err || msg}
        </div>
      )}

      {selectedEmail && (
        <div style={{ marginTop: 16, border: "1px solid #ddd", borderRadius: 14, padding: 14, background: "#fafafa" }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Link email → contact</div>
          <div style={{ color: "#666", marginTop: 6 }}>
            Email: <strong>{selectedEmail}</strong>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input
              value={contactQuery}
              onChange={(e) => {
                const v = e.target.value;
                setContactQuery(v);
                setSelectedContactId("");
                searchContacts(v);
              }}
              placeholder="Search contacts by name (e.g., 'Brad' or 'Ray')"
              style={{ padding: 10, width: 420, borderRadius: 10, border: "1px solid #ddd" }}
            />

            <select
              value={selectedContactId}
              onChange={(e) => setSelectedContactId(e.target.value)}
              style={{ padding: 10, minWidth: 360 }}
            >
              <option value="">Select a contact…</option>
              {contactResults.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name} • {c.category}
                  {c.tier ? ` • ${c.tier}` : ""}
                  {c.email ? ` • ${c.email}` : ""}
                </option>
              ))}
            </select>

            <button
              onClick={() => linkEmail(selectedEmail, selectedContactId)}
              disabled={busy || !selectedContactId}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #ddd",
                cursor: "pointer",
                fontWeight: 900,
              }}
            >
              Link
            </button>

            <button
              onClick={() => {
                setSelectedEmail(null);
                setSelectedContactId("");
                setContactQuery("");
                setContactResults([]);
              }}
              disabled={busy}
              style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
            >
              Cancel
            </button>
          </div>

          <div style={{ marginTop: 10, color: "#777", fontSize: 12 }}>
            Linking will: (1) add this email to <code>contact_emails</code>, (2) mark unmatched as <code>linked</code>.
          </div>
        </div>
      )}

      <div style={{ marginTop: 18, display: "grid", gap: 10 }}>
        {visible.map((r) => {
          const rec = classifyUnmatched(r.email, r.last_subject, r.last_snippet);
          return (
            <div
              key={r.id}
              style={{
                border: "1px solid #e5e5e5",
                borderRadius: 14,
                padding: 14,
                background: "#fff",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 900, fontSize: 16, wordBreak: "break-word" }}>{r.email}</div>
                  <div style={{ marginTop: 6, color: "#666", display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <span>
                      Seen: <strong>{r.seen_count}</strong>
                    </span>
                    <span>
                      Last: <strong>{new Date(r.last_seen_at).toLocaleString()}</strong>
                    </span>
                    <span>
                      Status: <strong>{r.status}</strong>
                    </span>
                    <span>
                      Guess: <strong>{rec.label}</strong> ({Math.round(rec.confidence * 100)}%)
                    </span>
                    {r.created_contact_id ? (
                      <span>
                        Contact: <strong>{r.created_contact_id.slice(0, 8)}…</strong>
                      </span>
                    ) : null}
                  </div>

                  {r.last_subject ? (
                    <div style={{ marginTop: 8, color: "#333" }}>
                      <strong>Subject:</strong> {r.last_subject}
                    </div>
                  ) : null}

                  {r.last_snippet ? <div style={{ marginTop: 6, color: "#444" }}>{r.last_snippet}</div> : null}

                  {r.last_thread_link ? (
                    <div style={{ marginTop: 8 }}>
                      <a href={r.last_thread_link} target="_blank" rel="noreferrer">
                        Open Gmail thread
                      </a>
                    </div>
                  ) : null}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 210 }}>
                  <button
                    onClick={() => setSelectedEmail(r.email)}
                    disabled={busy}
                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
                  >
                    Link to contact
                  </button>

                  <button
                    onClick={() => createContact(r.email)}
                    disabled={busy || !!r.created_contact_id}
                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
                  >
                    {r.created_contact_id ? "Contact created" : "Create contact"}
                  </button>

                  <button
                    onClick={() => ignoreEmail(r.email)}
                    disabled={busy}
                    style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer" }}
                  >
                    Ignore
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {visible.length === 0 ? <div style={{ color: "#666" }}>Nothing to review 🎉</div> : null}
      </div>
    </div>
  );
}