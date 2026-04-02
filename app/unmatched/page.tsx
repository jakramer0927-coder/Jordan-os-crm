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

type CreateForm = {
  email: string;
  name: string;
  category: string;
  tier: string;
};

function domainOf(email: string) {
  return (email.split("@")[1] || "").toLowerCase().trim();
}

function displayFromEmail(email: string): string {
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

  // Link flow
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [contactQuery, setContactQuery] = useState("");
  const [contactResults, setContactResults] = useState<ContactLite[]>([]);
  const [selectedContactId, setSelectedContactId] = useState<string>("");

  // Create flow — stores the email being created, null = form closed
  const [createForm, setCreateForm] = useState<CreateForm | null>(null);

  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    setMsg(null);

    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) { window.location.href = "/login"; return; }
    setUid(user.id);

    const res = await fetch(`/api/unmatched/list?uid=${user.id}`);
    const j = await res.json();
    if (!res.ok) { setErr(j?.error || "Failed to load"); setReady(true); return; }

    setRows((j.rows || []) as UnmatchedRow[]);
    setReady(true);
  }

  function openCreateForm(row: UnmatchedRow) {
    const rec = classifyUnmatched(row.email, row.last_subject, row.last_snippet);
    setCreateForm({
      email: row.email,
      name: displayFromEmail(row.email),
      category: rec.suggestedCategory,
      tier: "B",
    });
    setSelectedEmail(null); // close link panel if open
    setErr(null);
    setMsg(null);
  }

  async function submitCreate() {
    if (!createForm) return;
    const { data: sd } = await supabase.auth.getSession();
    const activeUid = sd.session?.user?.id ?? uid;
    if (!activeUid) return;

    setBusy(true);
    setErr(null);
    setMsg(null);

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

    setMsg(`Created: ${j.display_name}`);
    setCreateForm(null);
    await load();
  }

  async function ignoreEmail(email: string) {
    const { data: sd } = await supabase.auth.getSession();
    const activeUid = sd.session?.user?.id ?? uid;
    if (!activeUid) return;
    setBusy(true); setErr(null); setMsg(null);

    const res = await fetch(`/api/unmatched/ignore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: activeUid, email }),
    });

    const j = await res.json();
    setBusy(false);
    if (!res.ok) { setErr(j?.error || "Ignore failed"); return; }
    setMsg("Ignored.");
    await load();
  }

  async function searchContacts(q: string) {
    if (!uid || !q.trim()) { setContactResults([]); return; }
    const res = await fetch(`/api/contacts/search?uid=${uid}&q=${encodeURIComponent(q.trim())}`);
    const j = await res.json();
    setContactResults(res.ok ? (j.results || []) as ContactLite[] : []);
  }

  async function linkEmail(email: string, contactId: string) {
    const { data: sd } = await supabase.auth.getSession();
    const activeUid = sd.session?.user?.id ?? uid;
    if (!activeUid) return;
    if (!contactId) { setErr("Pick a contact to link to."); return; }

    setBusy(true); setErr(null); setMsg(null);

    const res = await fetch(`/api/unmatched/link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: activeUid, email, contact_id: contactId }),
    });

    const j = await res.json();
    setBusy(false);
    if (!res.ok) { setErr(j?.error || "Link failed"); return; }

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

  const visible = useMemo(
    () => rows.filter((r) => r.status !== "ignored" && r.status !== "linked" && r.status !== "auto_created"),
    [rows],
  );

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

      {(err || msg) && (
        <div className={`alert ${err ? "alertError" : "alertOk"}`}>{err || msg}</div>
      )}

      {/* Link panel */}
      {selectedEmail && (
        <div className="card cardPad stack" style={{ background: "rgba(247,244,238,.55)" }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Link email → contact</div>
          <div className="subtle">Email: <strong>{selectedEmail}</strong></div>

          <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap" }}>
            <div className="field" style={{ width: 420, minWidth: 260 }}>
              <div className="label">Search contacts</div>
              <input
                className="input"
                value={contactQuery}
                onChange={(e) => { setContactQuery(e.target.value); setSelectedContactId(""); searchContacts(e.target.value); }}
                placeholder="Search by name"
              />
            </div>
            <div className="field" style={{ minWidth: 360, flex: 1 }}>
              <div className="label">Pick contact</div>
              <select className="select" value={selectedContactId} onChange={(e) => setSelectedContactId(e.target.value)}>
                <option value="">Select a contact…</option>
                {contactResults.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name} • {c.category}{c.tier ? ` • ${c.tier}` : ""}{c.email ? ` • ${c.email}` : ""}
                  </option>
                ))}
              </select>
            </div>
            <button className="btn btnPrimary" onClick={() => linkEmail(selectedEmail, selectedContactId)} disabled={busy || !selectedContactId}>Link</button>
            <button className="btn" onClick={() => { setSelectedEmail(null); setSelectedContactId(""); setContactQuery(""); setContactResults([]); }} disabled={busy}>Cancel</button>
          </div>
        </div>
      )}

      {/* Create contact panel */}
      {createForm && (
        <div className="card cardPad stack" style={{ background: "rgba(247,244,238,.55)" }}>
          <div className="rowBetween">
            <div style={{ fontWeight: 900, fontSize: 16 }}>Create contact</div>
            <button className="btn" onClick={() => setCreateForm(null)} disabled={busy}>Cancel</button>
          </div>
          <div className="subtle">Email: <strong>{createForm.email}</strong></div>

          <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: 12 }}>
            <div className="field" style={{ flex: 1, minWidth: 220 }}>
              <div className="label">Name</div>
              <input
                className="input"
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => f ? { ...f, name: e.target.value } : f)}
                placeholder="Full name"
              />
            </div>

            <div className="field" style={{ minWidth: 160 }}>
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

            <div className="field" style={{ minWidth: 100 }}>
              <div className="label">Tier</div>
              <select className="select" value={createForm.tier} onChange={(e) => setCreateForm((f) => f ? { ...f, tier: e.target.value } : f)}>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
              </select>
            </div>

            <button className="btn btnPrimary" onClick={submitCreate} disabled={busy || !createForm.name.trim()}>
              {busy ? "Creating…" : "Create"}
            </button>
          </div>
        </div>
      )}

      <div className="stack">
        {visible.map((r) => {
          const rec = classifyUnmatched(r.email, r.last_subject, r.last_snippet);
          const isCreating = createForm?.email === r.email;
          return (
            <div key={r.id} className="card cardPad">
              <div className="rowBetween" style={{ alignItems: "flex-start" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 900, fontSize: 16, wordBreak: "break-word" }}>{r.email}</div>

                  <div className="row" style={{ marginTop: 10 }}>
                    <span className="badge">Seen {r.seen_count}</span>
                    <span className="badge">Last {new Date(r.last_seen_at).toLocaleString()}</span>
                    <span className="badge">Status {r.status}</span>
                    <span className="badge">{rec.label} ({Math.round(rec.confidence * 100)}%)</span>
                  </div>

                  {r.last_subject && (
                    <div style={{ marginTop: 12 }}>
                      <div className="label">Subject</div>
                      <div style={{ fontWeight: 800 }}>{r.last_subject}</div>
                    </div>
                  )}

                  {r.last_snippet && (
                    <div style={{ marginTop: 8 }}>
                      <div className="subtle" style={{ color: "rgba(18,18,18,.78)" }}>{r.last_snippet}</div>
                    </div>
                  )}

                  {r.last_thread_link && (
                    <div style={{ marginTop: 8 }}>
                      <a href={r.last_thread_link} target="_blank" rel="noreferrer">Open Gmail thread</a>
                    </div>
                  )}
                </div>

                <div className="stack" style={{ minWidth: 200 }}>
                  <button className="btn btnPrimary" onClick={() => { setSelectedEmail(r.email); setCreateForm(null); }} disabled={busy}>
                    Link to contact
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
            </div>
          );
        })}

        {visible.length === 0 && <div className="subtle">Nothing to review 🎉</div>}
      </div>
    </div>
  );
}
