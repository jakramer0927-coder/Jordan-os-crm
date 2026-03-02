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

  async function search(query: string) {
    if (!uid) return;
    const term = query.trim();
    if (!term) {
      setRows([]);
      return;
    }

    setBusy(true);
    setErr(null);

    const res = await fetch(`/api/contacts/search?uid=${uid}&q=${encodeURIComponent(term)}`);
    const j = await res.json();

    setBusy(false);

    if (!res.ok) {
      setErr(j?.error || "Search failed");
      setRows([]);
      return;
    }

    setRows((j.results || []) as ContactLite[]);
  }

  // debounce
  useEffect(() => {
    const t = setTimeout(() => {
      search(q);
    }, 180);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, uid]);

  useEffect(() => {
    requireSession().then((u) => {
      if (u) setReady(true);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hint = useMemo(() => {
    if (!q.trim()) return "Type a name, email, or company…";
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
        </div>
      </div>

      {err ? <div className="alert alertError">{err}</div> : null}

      <div className="card cardPad">
        <input
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search contacts…"
        />
      </div>

      <div className="section" style={{ marginTop: 14 }}>
        <div className="stack">
          {rows.map((c) => (
            <a key={c.id} className="card cardPad" href={`/contacts/${c.id}`} style={{ textDecoration: "none" }}>
              <div className="rowBetween">
                <div style={{ fontWeight: 900 }}>{c.display_name}</div>
                <div className="muted small">
                  {c.category}{c.tier ? ` • ${c.tier}` : ""}{c.email ? ` • ${c.email}` : ""}
                </div>
              </div>
            </a>
          ))}

          {q.trim() && !busy && rows.length === 0 ? (
            <div className="muted">No matches.</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}