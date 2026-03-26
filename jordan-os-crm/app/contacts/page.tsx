"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

type ContactLite = {
  id: string;
  display_name: string;
  category: string;
  tier: string | null;
  email: string | null;
  company?: string | null;
};

export default function ContactsPage() {
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ContactLite[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // add contact form
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addCategory, setAddCategory] = useState("Client");
  const [addTier, setAddTier] = useState<"A" | "B" | "C">("B");
  const [addClientType, setAddClientType] = useState("");
  const [addCompany, setAddCompany] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);

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

  async function loadRecent(userId: string) {
    setBusy(true);
    setErr(null);

    // Uses RLS via supabase client. If you don’t have RLS policies, this will fail — but most setups do.
    const { data, error } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, email, company")
      .order("created_at", { ascending: false })
      .limit(200);

    setBusy(false);

    if (error) {
      setErr(`Load contacts failed: ${error.message}`);
      setRows([]);
      return;
    }

    setRows((data ?? []) as ContactLite[]);
  }

  async function search(term: string) {
    if (!uid) return;

    const qRaw = term.trim();
    if (!qRaw) {
      // empty search -> show recent
      await loadRecent(uid);
      return;
    }

    // guard to keep it snappy
    if (qRaw.length < 2) return;

    // cancel in-flight request
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setBusy(true);
    setErr(null);

    try {
      const res = await fetch(`/api/contacts/search?uid=${uid}&q=${encodeURIComponent(qRaw)}`, {
        signal: ac.signal,
      });

      const j = await res.json().catch(() => ({}));

      if (!res.ok) {
        setErr(j?.error || "Search failed");
        setRows([]);
        return;
      }

      setRows((j.results || []) as ContactLite[]);
    } catch (e: any) {
      // ignore abort errors
      if (e?.name !== "AbortError") setErr(e?.message || "Search failed");
    } finally {
      setBusy(false);
    }
  }

  async function addContact() {
    if (!uid || !addName.trim()) return;
    setAddBusy(true);
    setAddErr(null);

    const { error } = await supabase.from("contacts").insert({
      user_id: uid,
      display_name: addName.trim(),
      category: addCategory,
      tier: addTier,
      client_type: addClientType.trim() || null,
      company: addCompany.trim() || null,
      email: addEmail.trim().toLowerCase() || null,
    });

    setAddBusy(false);

    if (error) {
      setAddErr(error.message);
      return;
    }

    // reset form and close
    setAddName(""); setAddCategory("Client"); setAddTier("B");
    setAddClientType(""); setAddCompany(""); setAddEmail("");
    setAddOpen(false);
    loadRecent(uid);
  }

  // init
  useEffect(() => {
    requireSession().then((u) => {
      if (!u) return;
      setReady(true);
      loadRecent(u.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // debounce search
  useEffect(() => {
    if (!uid) return;
    const t = setTimeout(() => {
      search(q);
    }, 220);

    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, uid]);

  const hint = useMemo(() => {
    const qt = q.trim();
    if (!qt) return busy ? "Loading recent…" : `${rows.length} recent`;
    if (qt.length < 2) return "Type 2+ characters…";
    if (busy) return "Searching…";
    return `${rows.length} result(s)`;
  }, [q, busy, rows.length]);

  if (!ready) return <div className="page">Loading…</div>;

  return (
    <div className="page">
      <div className="pageHeader">
        <div>
          <h1 className="h1">Contacts</h1>
          <div className="muted" style={{ marginTop: 8 }}>
            <span className="badge">{hint}</span>
          </div>
        </div>

        <div className="row">
          <a className="btn" href="/morning">Morning</a>
          <a className="btn" href="/unmatched">Unmatched</a>
          <button className="btn btnPrimary" onClick={() => { setAddOpen((v) => !v); setAddErr(null); }}>
            {addOpen ? "Cancel" : "Add contact"}
          </button>
        </div>
      </div>

      {err ? <div className="alert alertError">{err}</div> : null}

      {addOpen && (
        <div className="card cardPad stack">
          <div style={{ fontWeight: 900 }}>New contact</div>

          {addErr && <div className="alert alertError">{addErr}</div>}

          <div className="fieldGridMobile" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ flex: 2, minWidth: 220 }}>
              <div className="label">Name *</div>
              <input
                className="input"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="Full name"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && addContact()}
              />
            </div>

            <div className="field" style={{ width: 160 }}>
              <div className="label">Category</div>
              <select className="select" value={addCategory} onChange={(e) => setAddCategory(e.target.value)}>
                <option>Client</option>
                <option>Agent</option>
                <option>Developer</option>
                <option>Vendor</option>
                <option>Other</option>
              </select>
            </div>

            <div className="field" style={{ width: 100 }}>
              <div className="label">Tier</div>
              <select className="select" value={addTier} onChange={(e) => setAddTier(e.target.value as any)}>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
              </select>
            </div>
          </div>

          <div className="fieldGridMobile" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ flex: 1, minWidth: 180 }}>
              <div className="label">Company (optional)</div>
              <input className="input" value={addCompany} onChange={(e) => setAddCompany(e.target.value)} placeholder="Compass, etc." />
            </div>

            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <div className="label">Email (optional)</div>
              <input className="input" type="email" value={addEmail} onChange={(e) => setAddEmail(e.target.value)} placeholder="email@example.com" />
            </div>

            <div className="field" style={{ flex: 1, minWidth: 180 }}>
              <div className="label">Client type (optional)</div>
              <input className="input" value={addClientType} onChange={(e) => setAddClientType(e.target.value)} placeholder="buyer / seller / sphere…" />
            </div>
          </div>

          <div className="row">
            <button className="btn btnPrimary" onClick={addContact} disabled={addBusy || !addName.trim()}>
              {addBusy ? "Saving…" : "Save"}
            </button>
            <button className="btn" onClick={() => setAddOpen(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card cardPad">
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, email, company…"
          autoFocus={!addOpen}
        />
      </div>

      <div className="section" style={{ marginTop: 14 }}>
        <div className="stack">
          {rows.map((c) => (
            <a
              key={c.id}
              className="card cardPad"
              href={`/contacts/${c.id}`}
              style={{ textDecoration: "none" }}
            >
              <div className="rowBetween">
                <div style={{ fontWeight: 900 }}>{c.display_name}</div>
                <div className="muted small">
                  {c.category}
                  {c.tier ? ` • ${c.tier}` : ""}
                  {c.company ? ` • ${c.company}` : ""}
                  {c.email ? ` • ${c.email}` : ""}
                </div>
              </div>
            </a>
          ))}

          {!busy && rows.length === 0 ? <div className="muted">No matches.</div> : null}
        </div>
      </div>
    </div>
  );
}
