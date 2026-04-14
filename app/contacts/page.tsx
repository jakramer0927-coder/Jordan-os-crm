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

const CATEGORIES = ["All", "Client", "Agent", "Developer", "Vendor", "Sphere", "Other"];
const TIERS = ["All", "A", "B", "C"];
const NEW_CATEGORIES = ["Client", "Agent", "Developer", "Vendor", "Sphere", "Other"];

export default function ContactsPage() {
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ContactLite[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [categoryFilter, setCategoryFilter] = useState("All");
  const [tierFilter, setTierFilter] = useState("All");

  // quick-add form
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("Client");
  const [newTier, setNewTier] = useState("A");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

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

    const { data, error } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, email, company")
      .neq("archived", true)
      .order("created_at", { ascending: false })
      .limit(500);

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
      await loadRecent(uid);
      return;
    }

    if (qRaw.length < 2) return;

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
      if (e?.name !== "AbortError") setErr(e?.message || "Search failed");
    } finally {
      setBusy(false);
    }
  }

  async function addContact() {
    if (!newName.trim()) { setAddErr("Name is required."); return; }
    setAdding(true);
    setAddErr(null);
    try {
      const res = await fetch("/api/contacts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: [{
            display_name: newName.trim(),
            category: newCategory.toLowerCase(),
            tier: newTier,
            client_type: "",
            email: newEmail.trim(),
            phone: newPhone.trim(),
            company: "",
            notes: newNotes.trim(),
          }],
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.errors?.length) {
        setAddErr(j.errors?.[0]?.error ?? j.error ?? "Failed to add contact.");
        return;
      }
      if (j.skipped > 0 && j.inserted === 0) {
        setAddErr("A contact with that name already exists.");
        return;
      }
      // Reset form and reload
      setNewName(""); setNewCategory("Client"); setNewTier("A");
      setNewEmail(""); setNewPhone(""); setNewNotes("");
      setAddOpen(false);
      if (uid) await loadRecent(uid);
    } catch (e: any) {
      setAddErr(e?.message ?? "Unexpected error.");
    } finally {
      setAdding(false);
    }
  }

  useEffect(() => {
    requireSession().then((u) => {
      if (!u) return;
      setReady(true);
      loadRecent(u.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!uid) return;
    const t = setTimeout(() => { search(q); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, uid]);

  const filtered = useMemo(() => {
    return rows.filter((c) => {
      if (categoryFilter !== "All" && (c.category || "").toLowerCase() !== categoryFilter.toLowerCase()) return false;
      if (tierFilter !== "All" && (c.tier || "").toUpperCase() !== tierFilter) return false;
      return true;
    });
  }, [rows, categoryFilter, tierFilter]);

  const hint = useMemo(() => {
    const qt = q.trim();
    const hasFilter = categoryFilter !== "All" || tierFilter !== "All";
    if (!qt && !hasFilter) return busy ? "Loading…" : `${filtered.length} contacts`;
    if (qt.length === 1) return "Type 2+ characters…";
    if (busy) return "Searching…";
    return `${filtered.length} result(s)`;
  }, [q, busy, filtered.length, categoryFilter, tierFilter]);

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
            {addOpen ? "Cancel" : "+ Add contact"}
          </button>
        </div>
      </div>

      {err ? <div className="alert alertError">{err}</div> : null}

      {addOpen && (
        <div className="card cardPad stack">
          <div style={{ fontWeight: 900, fontSize: 15 }}>New contact</div>
          {addErr && <div className="alert alertError" style={{ fontSize: 13 }}>{addErr}</div>}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
            <div className="field">
              <div className="label">Name *</div>
              <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Full name" autoFocus />
            </div>
            <div className="field">
              <div className="label">Category</div>
              <select className="select" value={newCategory} onChange={(e) => setNewCategory(e.target.value)}>
                {NEW_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="field">
              <div className="label">Tier</div>
              <select className="select" value={newTier} onChange={(e) => setNewTier(e.target.value)}>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
              </select>
            </div>
            <div className="field">
              <div className="label">Email</div>
              <input className="input" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="name@example.com" />
            </div>
            <div className="field">
              <div className="label">Phone</div>
              <input className="input" type="tel" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="(310) 555-0100" />
            </div>
          </div>

          <div className="field">
            <div className="label">Notes (optional)</div>
            <textarea className="textarea" value={newNotes} onChange={(e) => setNewNotes(e.target.value)} placeholder="Context, relationship notes…" style={{ minHeight: 60 }} />
          </div>

          <div className="row">
            <button className="btn btnPrimary" onClick={addContact} disabled={adding}>
              {adding ? "Adding…" : "Add contact"}
            </button>
            <button className="btn" onClick={() => { setAddOpen(false); setAddErr(null); }}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card cardPad stack" style={{ gap: 10 }}>
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search contacts…"
        />

        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <div className="row" style={{ gap: 4 }}>
            {CATEGORIES.map((cat) => (
              <button
                key={cat}
                className="btn"
                style={{
                  fontSize: 12,
                  padding: "2px 10px",
                  fontWeight: categoryFilter === cat ? 900 : 400,
                  background: categoryFilter === cat ? "var(--ink)" : undefined,
                  color: categoryFilter === cat ? "var(--paper)" : undefined,
                }}
                onClick={() => setCategoryFilter(cat)}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="row" style={{ gap: 4 }}>
            {TIERS.map((t) => (
              <button
                key={t}
                className="btn"
                style={{
                  fontSize: 12,
                  padding: "2px 10px",
                  fontWeight: tierFilter === t ? 900 : 400,
                  background: tierFilter === t ? "var(--ink)" : undefined,
                  color: tierFilter === t ? "var(--paper)" : undefined,
                }}
                onClick={() => setTierFilter(t)}
              >
                {t === "All" ? "All tiers" : `Tier ${t}`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="section" style={{ marginTop: 14 }}>
        <div className="stack">
          {filtered.map((c) => (
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
                  {c.tier ? ` • Tier ${c.tier}` : ""}
                  {c.company ? ` • ${c.company}` : ""}
                  {c.email ? ` • ${c.email}` : ""}
                </div>
              </div>
            </a>
          ))}

          {!busy && filtered.length === 0 ? <div className="muted">No matches.</div> : null}
        </div>
      </div>
    </div>
  );
}
