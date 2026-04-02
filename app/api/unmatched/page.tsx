"use client";

import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

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

function localPart(email: string) {
  const parts = email.split("@");
  return (parts[0] || "").toLowerCase().trim();
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

function looksInternalTeamEmail(email: string) {
  const d = domainOf(email);
  const lp = localPart(email);

  const internalDomains = new Set(["smithandberg.com"]);
  const internalLocalParts = new Set([
    "team",
    "admin",
    "info",
    "hello",
    "support",
    "noreply",
    "no-reply",
    "office",
  ]);

  if (internalDomains.has(d)) return true;
  if (internalLocalParts.has(lp)) return true;

  return false;
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

  async function requireSession() {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) {
      window.location.href = "/login";
      return null;
    }
    setUid(user.id);
    return user;
  }

  async function load() {
    setErr(null);
    setMsg(null);

    const user = await requireSession();
    if (!user) return;

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

  // -------- Actions --------

  async function ignoreEmail(email: string, opts?: { quiet?: boolean }) {
    if (!uid) return;
    if (!opts?.quiet) {
      setBusy(true);
      setErr(null);
      setMsg(null);
    }

    const res = await fetch(`/api/unmatched/ignore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, email }),
    });

    const j = await res.json();

    if (!opts?.quiet) setBusy(false);

    if (!res.ok) {
      if (!opts?.quiet) setErr(j?.error || "Ignore failed");
      throw new Error(j?.error || "Ignore failed");
    }

    return j;
  }

  async function ignoreDomain(domain: string) {
    if (!uid) return;
    setBusy(true);
    setErr(null);
    setMsg(null);

    const res = await fetch(`/api/unmatched/ignore-domain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, domain }),
    });

    const j = await res.json();
    setBusy(false);

    if (!res.ok) {
      setErr(j?.error || "Ignore domain failed");
      return;
    }

    setMsg(`Ignored domain: ${domain} (${j?.updated ?? "?"} rows)`);
    await load();
  }

  // Option B: add-contact endpoint
  async function addContact(email: string) {
    if (!uid) return;
    setBusy(true);
    setErr(null);
    setMsg(null);

    const res = await fetch(`/api/unmatched/add-contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, email }),
    });

    const j = await res.json();
    setBusy(false);

    if (!res.ok) {
      setErr(j?.error || "Add contact failed");
      return;
    }

    setMsg(`Created contact: ${j.display_name || "OK"}`);
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

    const res = await fetch(`/unmatched/link`, {
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

  async function ignoreInternalBatch() {
    if (!uid) return;

    const internal = visible.filter((r) => looksInternalTeamEmail(r.email)).slice(0, 250);
    if (internal.length === 0) {
      setMsg("No internal/team emails found to ignore.");
      return;
    }

    setBusy(true);
    setErr(null);
    setMsg(`Ignoring ${internal.length} internal/team emails…`);

    let ok = 0;
    let fail = 0;

    // IMPORTANT: don’t call load() on every ignore. We do one refresh at the end.
    for (const r of internal) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await ignoreEmail(r.email, { quiet: true });
        ok += 1;
      } catch {
        fail += 1;
      }
    }

    setBusy(false);
    setMsg(
      `Ignored ${ok}/${internal.length} internal/team emails${fail ? ` (${fail} failed)` : ""}.`,
    );
    await load();
  }

  // -------- Effects + derived --------

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => rows.filter((r) => r.status !== "ignored"), [rows]);

  const internalCount = useMemo(
    () => visible.filter((r) => looksInternalTeamEmail(r.email)).length,
    [visible],
  );

  if (!ready) return <div className="page">Loading…</div>;

  return (
    <div className="page">
      <div className="pageHeader">
        <div>
          <h1 className="h1">Unmatched</h1>
          <div className="muted" style={{ marginTop: 8 }}>
            Review Sent recipients not tied to your CRM yet.{" "}
            <span className="badge">{visible.length} items</span>{" "}
            {internalCount > 0 ? (
              <span className="badge">{internalCount} look internal/team</span>
            ) : null}
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
        <div
          className="card cardPad"
          style={{ borderColor: err ? "rgba(160,0,0,0.25)" : undefined }}
        >
          <div
            style={{ fontWeight: 900, color: err ? "#8a0000" : "#0b6b2a", whiteSpace: "pre-wrap" }}
          >
            {err || msg}
          </div>
        </div>
      )}

      <div className="section" style={{ marginTop: 14 }}>
        <div className="sectionTitleRow">
          <div className="sectionTitle">Fast actions</div>
          <div className="sectionSub">Clear noise first so the real people rise to the top.</div>
        </div>

        <div className="row">
          <button
            className="btn"
            onClick={ignoreInternalBatch}
            disabled={busy || internalCount === 0}
          >
            Ignore internal/team emails ({internalCount})
          </button>
        </div>

        <div className="muted small" style={{ marginTop: 10 }}>
          Tip: “Ignore domain” is available on each row — use it for vendor systems / internal
          distribution lists.
        </div>
      </div>

      {selectedEmail && (
        <div className="card cardPad" style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Link email → contact</div>
          <div className="muted" style={{ marginTop: 6 }}>
            Email: <strong>{selectedEmail}</strong>
          </div>

          <div className="row" style={{ marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
            <input
              className="input"
              value={contactQuery}
              onChange={(e) => {
                const v = e.target.value;
                setContactQuery(v);
                setSelectedContactId("");
                searchContacts(v);
              }}
              placeholder="Search contacts (name / email)"
              style={{ width: 420, maxWidth: "100%" }}
            />

            <select
              className="select"
              value={selectedContactId}
              onChange={(e) => setSelectedContactId(e.target.value)}
              style={{ minWidth: 340 }}
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
              className="btn btnPrimary"
              onClick={() => linkEmail(selectedEmail, selectedContactId)}
              disabled={busy || !selectedContactId}
            >
              Link
            </button>

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
          </div>

          <div className="muted small" style={{ marginTop: 10 }}>
            Linking will: add email → <code>contact_emails</code> and mark unmatched as{" "}
            <code>linked</code>.
          </div>
        </div>
      )}

      <div className="section" style={{ marginTop: 14 }}>
        <div className="sectionTitleRow">
          <div className="sectionTitle">Inbox to clean</div>
          <div className="sectionSub">Work top-down. Ignore noise aggressively.</div>
        </div>

        <div className="stack">
          {visible.map((r) => {
            const rec = classifyUnmatched(r.email, r.last_subject, r.last_snippet);
            const d = domainOf(r.email);
            const internal = looksInternalTeamEmail(r.email);

            const suggested = internal
              ? "Suggested: ignore (internal/team)"
              : rec.label === "Likely Agent"
                ? "Suggested: link to existing agent or create an Agent contact"
                : rec.label === "Likely Vendor"
                  ? "Suggested: create Vendor contact (or ignore system address)"
                  : rec.label === "Likely Client/Lead"
                    ? "Suggested: create Client/Lead contact"
                    : "Suggested: link if it’s a real person; otherwise ignore";

            return (
              <div key={r.id} className="card cardPad">
                <div
                  className="row"
                  style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 900, fontSize: 16, wordBreak: "break-word" }}>
                      {r.email}
                    </div>

                    <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
                      <span className="badge">Seen {r.seen_count}</span>
                      <span className="badge">
                        Last {new Date(r.last_seen_at).toLocaleString()}
                      </span>
                      <span className="badge">Status {r.status}</span>
                      <span className="badge">
                        Guess {rec.label} ({Math.round(rec.confidence * 100)}%)
                      </span>
                      <span className="badge">Domain {d}</span>
                      {internal ? <span className="badge">Internal/team</span> : null}
                      {r.created_contact_id ? <span className="badge">Contact created</span> : null}
                    </div>

                    <div className="cardSoft cardPad" style={{ marginTop: 10 }}>
                      <div className="small muted bold" style={{ marginBottom: 6 }}>
                        {suggested}
                      </div>
                      {r.last_subject ? (
                        <div className="small">
                          <span className="muted bold">Subject:</span> {r.last_subject}
                        </div>
                      ) : null}
                      {r.last_snippet ? (
                        <div className="small muted" style={{ marginTop: 6 }}>
                          {r.last_snippet}
                        </div>
                      ) : null}
                      {r.last_thread_link ? (
                        <div style={{ marginTop: 8 }}>
                          <a href={r.last_thread_link} target="_blank" rel="noreferrer">
                            Open Gmail thread
                          </a>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div style={{ display: "grid", gap: 8, minWidth: 240 }}>
                    <button
                      className="btn"
                      onClick={() => setSelectedEmail(r.email)}
                      disabled={busy}
                    >
                      Link to contact
                    </button>

                    <button
                      className="btn"
                      onClick={() => addContact(r.email)}
                      disabled={busy || !!r.created_contact_id}
                    >
                      {r.created_contact_id ? "Contact created" : "Create contact"}
                    </button>

                    <button
                      className="btn"
                      onClick={async () => {
                        try {
                          setBusy(true);
                          setErr(null);
                          setMsg(null);
                          await ignoreEmail(r.email, { quiet: true });
                          setMsg("Ignored.");
                          await load();
                        } catch (e: any) {
                          setErr(e?.message || "Ignore failed");
                        } finally {
                          setBusy(false);
                        }
                      }}
                      disabled={busy}
                    >
                      Ignore
                    </button>

                    <button className="btn" onClick={() => ignoreDomain(d)} disabled={busy}>
                      Ignore domain ({d})
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {visible.length === 0 ? <div className="muted">Nothing to review 🎉</div> : null}
        </div>
      </div>
    </div>
  );
}
