"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";

type ContactLite = {
  id: string;
  display_name: string;
  category: string;
  tier: string | null;
  email: string | null;
};

export default function ContactsPage() {
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ContactLite[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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

  // 🔹 Load recent contacts (on page load)
  async function loadRecent(userId: string) {
    setBusy(true);
    setErr(null);

    const { data, error } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier")
      .eq("user_id", userId) // remove if using RLS auth.uid()
      .order("created_at", { ascending: false })
      .limit(200);

    setBusy(false);

    if (error) {
      setErr(error.message);
      return;
    }

    setRows((data ?? []) as ContactLite[]);
  }

  // 🔹 Search (only when query >= 2 chars)
  async function search(userId: string, query: string) {
    const term = query.trim();
    if (term.length < 2) {
      await loadRecent(userId);
      return;
    }

    setBusy(true);
    setErr(null);

    const res = await fetch(`/api/contacts/search?uid=${userId}&q=${encodeURIComponent(term)}`);
    const j = await res.json();

    setBusy(false);

    if (!res.ok) {
      setErr(j?.error || "Search failed");
      return;
    }

    setRows((j.results || []) as ContactLite[]);
  }

  // 🔹 Debounce search
  useEffect(() => {
    if (!uid) return;

    const t = setTimeout(() => {
      search(uid, q);
    }, 300);

    return () => clearTimeout(t);
  }, [q, uid]);

  // 🔹 Initial load
  useEffect(() => {
    requireSession().then((u) => {
      if (!u) return;
      setReady(true);
      loadRecent(u.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hint = useMemo(() => {
    if (busy) return "Loading…";
    if (q.trim().length >= 2) return `${rows.length} result(s)`;
    return `${rows.length} recent contact(s)`;
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
        </div>
      </div>

      {err ? <div className="alert alertError">{err}</div> : null}

      <div className="card cardPad">
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search contacts… (min 2 characters)"
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
                </div>
              </div>
            </a>
          ))}

          {!busy && rows.length === 0 ? (
            <div className="muted">No contacts found.</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}