"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

  const abortRef = useRef<AbortController | null>(null);
  const reqSeq = useRef(0);

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
    if (term.length < 2) {
      // don’t spam DB for 0–1 chars
      setRows([]);
      setBusy(false);
      setErr(null);
      return;
    }

    // cancel previous
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const mySeq = ++reqSeq.current;

    setBusy(true);
    setErr(null);

    try {
      const res = await fetch(`/api/contacts/search?uid=${uid}&q=${encodeURIComponent(term)}`, {
        signal: ac.signal,
      });

      const j = await res.json();

      // if a newer request started, ignore this response
      if (mySeq !== reqSeq.current) return;

      if (!res.ok) {
        setErr(j?.error || "Search failed");
        setRows([]);
        setBusy(false);
        return;
      }

      setRows((j.results || []) as ContactLite[]);
      setBusy(false);
    } catch (e: any) {
      if (e?.name === "AbortError") return; // expected
      if (mySeq !== reqSeq.current) return;

      setErr(e?.message || "Search failed");
      setRows([]);
      setBusy(false);
    }
  }

  // debounce (a bit slower + safer)
  useEffect(() => {
    if (!uid) return;
    const t = setTimeout(() => search(q), 280);
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
    const term = q.trim();
    if (!term) return "Type at least 2 characters…";
    if (term.length < 2) return "Keep typing…";
    if (busy) return "Searching…";
    if (err) return "Search error";
    return `${rows.length} result(s)`;
  }, [q, busy, rows.length, err]);

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
          placeholder="Search name, email, company, phone…"
        />
        <div className="muted small" style={{ marginTop: 8 }}>
          Tip: name searches are prefix-based (fast). Email/phone searches match anywhere.
        </div>
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

          {q.trim().length >= 2 && !busy && rows.length === 0 ? (
            <div className="muted">No matches.</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}