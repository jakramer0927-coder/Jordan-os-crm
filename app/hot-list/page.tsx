"use client";

import { useEffect, useState, useCallback } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

type ScoredContact = {
  id: string;
  display_name: string;
  category: string;
  tier: string | null;
  transaction_score: number;
  transaction_score_rationale: string | null;
  score_updated_at: string | null;
  last_interaction_at: string | null;
};

function scoreBadge(score: number) {
  let bg: string, color: string, border: string;
  if (score >= 90) {
    bg = "rgba(200,0,0,.1)"; color = "#8a0000"; border = "rgba(200,0,0,.3)";
  } else if (score >= 80) {
    bg = "rgba(200,80,0,.1)"; color = "#c25a00"; border = "rgba(200,80,0,.3)";
  } else {
    bg = "rgba(200,160,0,.1)"; color = "#92610a"; border = "rgba(200,160,0,.3)";
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 6, background: bg, border: `1px solid ${border}`, fontWeight: 800, fontSize: 13, color }}>
      {score}
    </span>
  );
}

function daysSince(iso: string | null): string {
  if (!iso) return "Never";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d === 0 ? "Today" : d === 1 ? "Yesterday" : `${d}d ago`;
}

export default function HotListPage() {
  const [contacts, setContacts] = useState<ScoredContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rescoring, setRescoring] = useState<Record<string, boolean>>({});
  const [rescoreResults, setRescoreResults] = useState<Record<string, { score: number; rationale: string }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, transaction_score, transaction_score_rationale, score_updated_at, last_interaction_at")
      .gte("transaction_score", 70)
      .order("transaction_score", { ascending: false })
      .limit(100);
    if (err) { setError(err.message); setLoading(false); return; }
    setContacts((data ?? []) as ScoredContact[]);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function rescore(c: ScoredContact) {
    setRescoring(prev => ({ ...prev, [c.id]: true }));
    try {
      const res = await fetch("/api/contacts/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: c.id }),
      });
      const j = await res.json();
      if (res.ok) {
        setRescoreResults(prev => ({ ...prev, [c.id]: { score: j.transaction_score, rationale: j.rationale } }));
        // Update local list
        setContacts(prev => prev.map(x => x.id === c.id ? { ...x, transaction_score: j.transaction_score, transaction_score_rationale: j.rationale, score_updated_at: new Date().toISOString() } : x));
      }
    } finally {
      setRescoring(prev => ({ ...prev, [c.id]: false }));
    }
  }

  return (
    <div className="stack">
      <div className="card cardPad">
        <div className="rowBetween" style={{ flexWrap: "wrap", gap: 8 }}>
          <div>
            <h1 className="h1" style={{ margin: 0 }}>Hot List</h1>
            {!loading && (
              <div className="subtle" style={{ marginTop: 4, fontSize: 13 }}>
                {contacts.length} contact{contacts.length !== 1 ? "s" : ""} scoring 70+
              </div>
            )}
          </div>
          <button className="btn" style={{ fontSize: 12 }} onClick={load}>Refresh</button>
        </div>

        <div style={{ marginTop: 10, fontSize: 13, color: "rgba(18,18,18,.5)", lineHeight: 1.5 }}>
          Contacts with transaction likelihood ≥70. Scores run weekly — use "Rescore" to refresh an individual contact.
        </div>
      </div>

      {error && <div className="alert alertError">{error}</div>}

      {loading && (
        <div className="stack" style={{ gap: 8 }}>
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} style={{ height: 72, borderRadius: 8, background: "rgba(18,18,18,.06)", animation: "pulse 1.4s ease-in-out infinite" }} />
          ))}
        </div>
      )}

      {!loading && contacts.length === 0 && (
        <div className="card cardPad">
          <div className="subtle" style={{ fontSize: 14 }}>
            No contacts scored 70+ yet. Scores run weekly automatically, or use "Rescore Now" on any contact page.
          </div>
        </div>
      )}

      <div className="stack" style={{ gap: 6 }}>
        {contacts.map((c, idx) => {
          const result = rescoreResults[c.id];
          const currentScore = result?.score ?? c.transaction_score;
          const currentRationale = result?.rationale ?? c.transaction_score_rationale;

          return (
            <div key={c.id} className="card cardPad" style={{ padding: "12px 16px" }}>
              <div className="rowBetween" style={{ alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "rgba(18,18,18,.3)", minWidth: 22 }}>#{idx + 1}</span>
                    <a
                      href={`/contacts/${c.id}`}
                      style={{ fontWeight: 800, fontSize: 15, textDecoration: "none", color: "var(--ink)" }}
                    >
                      {c.display_name}
                    </a>
                    {scoreBadge(currentScore)}
                    <span className="badge" style={{ fontSize: 11 }}>{c.category}</span>
                    {c.tier && <span className="badge" style={{ fontSize: 11 }}>Tier {c.tier}</span>}
                  </div>

                  {currentRationale && (
                    <div style={{ fontSize: 13, color: "rgba(18,18,18,.65)", marginTop: 6, lineHeight: 1.5 }}>
                      {currentRationale}
                    </div>
                  )}

                  <div className="row" style={{ marginTop: 6, gap: 16, flexWrap: "wrap" }}>
                    <span className="subtle" style={{ fontSize: 11 }}>
                      Last interaction: {daysSince(c.last_interaction_at)}
                    </span>
                    {c.score_updated_at && (
                      <span className="subtle" style={{ fontSize: 11 }}>
                        Scored: {daysSince(c.score_updated_at)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                  <button
                    className="btn"
                    style={{ fontSize: 12 }}
                    onClick={() => rescore(c)}
                    disabled={rescoring[c.id]}
                  >
                    {rescoring[c.id] ? "Scoring…" : "Rescore"}
                  </button>
                  <a
                    href={`/contacts/${c.id}`}
                    className="btn"
                    style={{ fontSize: 12, textDecoration: "none" }}
                  >
                    View →
                  </a>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
