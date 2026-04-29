"use client";

import { useEffect, useMemo, useState } from "react";
import ContactSearchInput from "@/components/ContactSearchInput";
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


type CreateForm = {
  email: string;
  name: string;
  category: string;
  tier: string;
};

function domainOf(email: string) {
  return (email.split("@")[1] || "").toLowerCase().trim();
}

function isPhone(s: string): boolean {
  return s.startsWith("+") && !s.includes("@");
}

function displayFromEmail(email: string): string {
  if (isPhone(email)) return "";
  const local = email.split("@")[0] || email;
  return local
    .replace(/[._-]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || email;
}

function isConsumerDomain(domain: string) {
  return new Set([
    "gmail.com","googlemail.com","yahoo.com","yahoo.co.uk","icloud.com",
    "me.com","mac.com","hotmail.com","outlook.com","live.com","aol.com",
    "proton.me","protonmail.com",
  ]).has(domain);
}

function classifyUnmatched(email: string, subject?: string | null, snippet?: string | null) {
  const d = domainOf(email);
  const text = `${subject || ""} ${snippet || ""}`.toLowerCase();

  const vendorHints = [
    "escrow","title","lender","mortgage","loan","underwriting","appraisal",
    "appraiser","inspection","inspector","staging","stager","contractor",
    "plumber","electric","hvac","roof","pest","termite","photography",
    "photographer","cleaning","cleaner","moving","mover","insurance","warranty",
  ];
  const agentHints = [
    "dre","realtor","real estate","broker","brokerage","listing","offer",
    "open house","showing","mls","compass","sotheby","coldwell","kw","keller",
    "bhhs","berkshire","douglas elliman","the agency",
  ];

  const vendorScore =
    vendorHints.reduce((acc, k) => acc + (d.includes(k) || text.includes(k) ? 1 : 0), 0) +
    (d.includes("escrow") ? 2 : 0) + (d.includes("title") ? 2 : 0);
  const agentScore =
    agentHints.reduce((acc, k) => acc + (d.includes(k) || text.includes(k) ? 1 : 0), 0) +
    (d.includes("compass") ? 2 : 0);

  let label: "Likely Agent" | "Likely Vendor" | "Likely Client/Lead" | "Unclear" = "Unclear";
  let confidence = 0.5;
  let suggestedCategory = "Agent";

  if (vendorScore >= 2 && vendorScore >= agentScore + 1) {
    label = "Likely Vendor"; confidence = Math.min(0.95, 0.6 + vendorScore * 0.08); suggestedCategory = "Vendor";
  } else if (agentScore >= 2 && agentScore >= vendorScore + 1) {
    label = "Likely Agent"; confidence = Math.min(0.95, 0.6 + agentScore * 0.08); suggestedCategory = "Agent";
  } else if (isConsumerDomain(d)) {
    label = "Likely Client/Lead"; confidence = 0.65; suggestedCategory = "Client";
  }

  return { label, confidence, suggestedCategory };
}

export default function UnmatchedPage() {
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);

  const [rows, setRows] = useState<UnmatchedRow[]>([]);

  // Which row has link panel open (by email)
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);

  // Which row has create form open (by email)
  const [createForm, setCreateForm] = useState<CreateForm | null>(null);

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function getUid(): Promise<string | null> {
    const { data: sd } = await supabase.auth.getSession();
    const u = sd.session?.user ?? null;
    if (!u) { window.location.href = "/login"; return null; }
    return u.id;
  }

  async function load() {
    setErr(null);
    const activeUid = await getUid();
    if (!activeUid) return;
    setUid(activeUid);

    const res = await fetch(`/api/unmatched/list?uid=${activeUid}`);
    const j = await res.json();
    if (!res.ok) { setErr(j?.error || "Failed to load"); setReady(true); return; }
    setRows((j.rows || []) as UnmatchedRow[]);
    setReady(true);
  }

  // Remove a row optimistically (before re-fetch) so the UI updates instantly
  function removeRow(email: string) {
    setRows((prev) => prev.filter((r) => r.email !== email));
  }

  function openCreateForm(row: UnmatchedRow) {
    const rec = classifyUnmatched(row.email, row.last_subject, row.last_snippet);
    setCreateForm({
      email: row.email,
      name: displayFromEmail(row.email),
      category: rec.suggestedCategory,
      tier: "B",
    });
    setSelectedEmail(null);
    setErr(null);
  }

  function openLinkPanel(email: string) {
    setSelectedEmail(email);
    setCreateForm(null);
    setErr(null);
  }

  async function submitCreate() {
    if (!createForm) return;
    const activeUid = uid || await getUid();
    if (!activeUid) return;

    setBusy(true);
    setErr(null);

    const res = await fetch(`/api/unmatched/add-contact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uid: activeUid,
        email: createForm.email,
        display_name: createForm.name.trim(),
        category: createForm.category,
        tier: createForm.tier || null,
      }),
    });

    const j = await res.json();
    setBusy(false);

    if (!res.ok) { setErr(j?.error || "Create failed"); return; }

    const email = createForm.email;
    setCreateForm(null);
    removeRow(email);
  }

  async function ignoreEmail(email: string) {
    const activeUid = uid || await getUid();
    if (!activeUid) return;
    setBusy(true);
    setErr(null);

    const res = await fetch(`/api/unmatched/ignore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: activeUid, email }),
    });

    const j = await res.json();
    setBusy(false);
    if (!res.ok) { setErr(j?.error || "Ignore failed"); return; }
    removeRow(email);
  }

  async function linkEmail(email: string, contactId: string) {
    const activeUid = uid || await getUid();
    if (!activeUid) return;
    if (!contactId) { setErr("Pick a contact to link to."); return; }

    setBusy(true);
    setErr(null);

    const res = await fetch(`/api/unmatched/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: activeUid, email, contact_id: contactId }),
    });

    const j = await res.json();
    setBusy(false);
    if (!res.ok) { setErr(j?.error || "Link failed"); return; }

    setSelectedEmail(null);
    removeRow(email);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // API already filters ignored/linked/auto_created — rows is the visible set
  const visible = rows;

  if (!ready) return <div className="card cardPad">Loading…</div>;

  return (
    <div className="stack">
      <div className="rowBetween">
        <div>
          <h1 className="h1">Unmatched</h1>
          <div className="subtle" style={{ marginTop: 6 }}>
            Review sent emails not yet tied to your CRM. <strong>{visible.length}</strong> items.
          </div>
        </div>
        <div className="row">
          <a className="btn" href="/contacts" style={{ textDecoration: "none" }}>Contacts</a>
          <button className="btn" onClick={load} disabled={busy}>Refresh</button>
        </div>
      </div>

      {err && <div className="alert alertError">{err}</div>}

      <div className="stack">
        {visible.map((r) => {
          const rec = classifyUnmatched(r.email, r.last_subject, r.last_snippet);
          const isLinking = selectedEmail === r.email;
          const isCreating = createForm?.email === r.email;

          return (
            <div key={r.id} className="card cardPad stack">
              {/* Contact info row */}
              <div className="rowBetween" style={{ alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 900, fontSize: 16, wordBreak: "break-word" }}>{r.email}</div>

                  <div className="row" style={{ marginTop: 10 }}>
                    <span className="badge">Seen {r.seen_count}</span>
                    <span className="badge">Last {new Date(r.last_seen_at).toLocaleString()}</span>
                    {!isPhone(r.email) && <span className="badge">{rec.label} ({Math.round(rec.confidence * 100)}%)</span>}
                  </div>

                  {r.last_subject && (
                    <div style={{ marginTop: 10 }}>
                      <div className="label">Subject</div>
                      <div style={{ fontWeight: 800 }}>{r.last_subject}</div>
                    </div>
                  )}

                  {r.last_snippet && (
                    <div style={{ marginTop: 6 }}>
                      <div className="subtle" style={{ color: "rgba(18,18,18,.78)" }}>{r.last_snippet}</div>
                    </div>
                  )}

                  {r.last_thread_link && (
                    <div style={{ marginTop: 6 }}>
                      <a href={r.last_thread_link} target="_blank" rel="noreferrer">Open Gmail thread</a>
                    </div>
                  )}
                </div>

                <div className="stack" style={{ minWidth: 180, flexShrink: 0 }}>
                  <button
                    className={`btn ${isLinking ? "" : "btnPrimary"}`}
                    onClick={() => isLinking ? setSelectedEmail(null) : openLinkPanel(r.email)}
                    disabled={busy}
                  >
                    {isLinking ? "Cancel link" : "Link to contact"}
                  </button>
                  <button
                    className="btn"
                    onClick={() => isCreating ? setCreateForm(null) : openCreateForm(r)}
                    disabled={busy}
                  >
                    {isCreating ? "Cancel create" : "Create contact"}
                  </button>
                  <button className="btn btnGhost" onClick={() => ignoreEmail(r.email)} disabled={busy}>
                    Ignore
                  </button>
                </div>
              </div>

              {/* Inline link panel */}
              {isLinking && (
                <div className="stack" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(0,0,0,0.08)" }}>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>Link to contact</div>
                  <ContactSearchInput
                    selectedId=""
                    selectedName=""
                    onSelect={(id) => linkEmail(r.email, id)}
                    placeholder="Search or create a contact…"
                    autoFocus
                  />
                </div>
              )}

              {/* Inline create form */}
              {isCreating && createForm && (
                <div className="stack" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(0,0,0,0.08)" }}>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>Create new contact</div>
                  <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: 10 }}>
                    <div className="field" style={{ flex: 1, minWidth: 200 }}>
                      <div className="label">Name</div>
                      <input
                        className="input"
                        value={createForm.name}
                        onChange={(e) => setCreateForm((f) => f ? { ...f, name: e.target.value } : f)}
                        placeholder="Full name"
                        autoFocus
                      />
                    </div>
                    <div className="field" style={{ minWidth: 150 }}>
                      <div className="label">Category</div>
                      <select className="select" value={createForm.category} onChange={(e) => setCreateForm((f) => f ? { ...f, category: e.target.value } : f)}>
                        <option>Agent</option>
                        <option>Client</option>
                        <option>Developer</option>
                        <option>Vendor</option>
                        <option>Sphere</option>
                        <option>Other</option>
                      </select>
                    </div>
                    <div className="field" style={{ minWidth: 90 }}>
                      <div className="label">Tier</div>
                      <select className="select" value={createForm.tier} onChange={(e) => setCreateForm((f) => f ? { ...f, tier: e.target.value } : f)}>
                        <option value="A">A</option>
                        <option value="B">B</option>
                        <option value="C">C</option>
                        <option value="D">D</option>
                      </select>
                    </div>
                    <button
                      className="btn btnPrimary"
                      onClick={submitCreate}
                      disabled={busy || !createForm.name.trim()}
                    >
                      {busy ? "Creating…" : "Create"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {visible.length === 0 && (
          <div className="card cardPad">
            <div className="subtle">Nothing to review — inbox is clean.</div>
          </div>
        )}
      </div>
    </div>
  );
}
