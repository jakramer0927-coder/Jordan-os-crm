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
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(50);

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
          <a className="btn" href="/morning">
            Morning
          </a>
          <a className="btn" href="/unmatched">
            Unmatched
          </a>
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
        <div className="muted small" style={{ marginTop: 8 }}>
          Tip: leave blank to see your most recently updated contacts.
        </div>
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
