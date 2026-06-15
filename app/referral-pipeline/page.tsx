"use client";

import { useEffect, useState, useCallback } from "react";

type ReferralContact = {
  id: string;
  display_name: string;
  category: string;
  tier: string | null;
  client_type: string | null;
  email: string | null;
  phone: string | null;
  last_referral_ask_date: string | null;
  referral_ask_count: number;
  life_event_flags: string[] | null;
  last_touch_date: string | null;
  last_interaction_summary: string | null;
  transaction_history: string | null;
};

type FilterType = "all" | "Client" | "Sphere" | "Agent" | "A" | "B";

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function fmtDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function ReferralPipelinePage() {
  const [contacts, setContacts] = useState<ReferralContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>("all");
  const [showRecentlyAsked, setShowRecentlyAsked] = useState(false);

  // Per-contact state
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [generating, setGenerating] = useState<Record<string, boolean>>({});
  const [draftOpen, setDraftOpen] = useState<Record<string, boolean>>({});
  const [logNoteOpen, setLogNoteOpen] = useState<Record<string, boolean>>({});
  const [logNotes, setLogNotes] = useState<Record<string, string>>({});
  const [logging, setLogging] = useState<Record<string, boolean>>({});
  const [loggedIds, setLoggedIds] = useState<Set<string>>(new Set());

  const loadContacts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/referral-pipeline/contacts");
      const j = await res.json();
      if (!res.ok) { setError(j?.error ?? "Failed to load"); return; }
      setContacts(j.contacts ?? []);
    } catch (e: any) {
      setError(e?.message ?? "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadContacts(); }, [loadContacts]);

  async function generateAsk(c: ReferralContact) {
    setGenerating(prev => ({ ...prev, [c.id]: true }));
    setDraftOpen(prev => ({ ...prev, [c.id]: true }));
    try {
      const res = await fetch("/api/referral-pipeline/generate-ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: c.display_name,
          category: c.category,
          last_interaction_summary: c.last_interaction_summary,
          transaction_history: c.transaction_history,
          life_event_flags: c.life_event_flags,
          last_referral_ask_date: c.last_referral_ask_date,
        }),
      });
      const j = await res.json();
      if (!res.ok) { setDrafts(prev => ({ ...prev, [c.id]: `Error: ${j?.error ?? "Failed"}` })); return; }
      setDrafts(prev => ({ ...prev, [c.id]: j.draft ?? "" }));
    } finally {
      setGenerating(prev => ({ ...prev, [c.id]: false }));
    }
  }

  async function logAsk(c: ReferralContact) {
    setLogging(prev => ({ ...prev, [c.id]: true }));
    try {
      const res = await fetch("/api/referral-pipeline/log-ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: c.id, note: logNotes[c.id] ?? "" }),
      });
      if (res.ok) {
        setLoggedIds(prev => new Set([...prev, c.id]));
        setLogNoteOpen(prev => ({ ...prev, [c.id]: false }));
        setDraftOpen(prev => ({ ...prev, [c.id]: false }));
        // Refresh list
        await loadContacts();
      }
    } finally {
      setLogging(prev => ({ ...prev, [c.id]: false }));
    }
  }

  const filtered = contacts.filter(c => {
    if (!showRecentlyAsked && loggedIds.has(c.id)) return false;
    if (filter === "all") return true;
    if (filter === "A" || filter === "B") return c.tier === filter;
    return c.category === filter;
  });

  const FILTERS: { value: FilterType; label: string }[] = [
    { value: "all", label: "All" },
    { value: "Client", label: "Clients" },
    { value: "Sphere", label: "Sphere" },
    { value: "Agent", label: "Agents" },
    { value: "A", label: "Tier A" },
    { value: "B", label: "Tier B" },
  ];

  return (
    <div className="stack">
      <div className="card cardPad">
        <div className="rowBetween" style={{ flexWrap: "wrap", gap: 8 }}>
          <div>
            <div className="eyebrow">Referrals</div>
            <h1 className="h1" style={{ margin: 0 }}>Referral pipeline</h1>
            {!loading && (
              <div className="subtle" style={{ marginTop: 6, fontSize: 13 }}>
                {filtered.length} contact{filtered.length !== 1 ? "s" : ""} due for referral ask
              </div>
            )}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={showRecentlyAsked}
              onChange={e => setShowRecentlyAsked(e.target.checked)}
            />
            Show recently asked
          </label>
        </div>

        <div className="row" style={{ marginTop: 12, gap: 6, flexWrap: "wrap" }}>
          {FILTERS.map(f => (
            <button
              key={f.value}
              className={`btn${filter === f.value ? " btnPrimary" : ""}`}
              style={{ fontSize: 12, padding: "3px 10px" }}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="card cardPad stack" style={{ gap: 10 }}>
          {[1, 2, 3].map(i => (
            <div key={i} style={{ height: 56, borderRadius: 8, background: "rgba(18,18,18,.06)", animation: "pulse 1.4s ease-in-out infinite" }} />
          ))}
        </div>
      )}

      {error && <div className="alert alertError">{error}</div>}

      {!loading && filtered.length === 0 && (
        <div className="card cardPad">
          <div className="subtle" style={{ fontSize: 14 }}>No contacts due for a referral ask.</div>
        </div>
      )}

      <div className="stack" style={{ gap: 8 }}>
        {filtered.map(c => {
          const daysSinceTouch = daysSince(c.last_touch_date);
          const daysSinceAsk = daysSince(c.last_referral_ask_date);
          const isLogged = loggedIds.has(c.id);

          return (
            <div key={c.id} className="card cardPad stack" style={{ gap: 10, opacity: isLogged ? 0.55 : 1 }}>
              {/* Row: name + meta + actions */}
              <div className="rowBetween" style={{ alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <a href={`/contacts/${c.id}`} style={{ fontWeight: 800, fontSize: 15, textDecoration: "none", color: "var(--ink)" }}>
                      {c.display_name}
                    </a>
                    <span className="badge" style={{ fontSize: 11 }}>{c.category}</span>
                    {c.tier && <span className="badge" style={{ fontSize: 11 }}>Tier {c.tier}</span>}
                    {isLogged && <span style={{ fontSize: 11, color: "#0b6b2a", fontWeight: 700 }}>✓ Ask logged</span>}
                  </div>
                  <div className="row" style={{ marginTop: 5, gap: 14, flexWrap: "wrap" }}>
                    <span className="subtle" style={{ fontSize: 12 }}>
                      Last touch: {daysSinceTouch === null ? "Never" : `${daysSinceTouch}d ago`}
                    </span>
                    <span className="subtle" style={{ fontSize: 12 }}>
                      Last ask: {c.last_referral_ask_date ? `${fmtDate(c.last_referral_ask_date)} (${daysSinceAsk}d ago)` : "Never"}
                    </span>
                    {c.referral_ask_count > 0 && (
                      <span className="subtle" style={{ fontSize: 12 }}>
                        {c.referral_ask_count} total asks
                      </span>
                    )}
                  </div>
                  {c.last_interaction_summary && (
                    <div className="subtle" style={{ fontSize: 12, marginTop: 4, fontStyle: "italic" }}>
                      Last note: {c.last_interaction_summary}
                    </div>
                  )}
                </div>

                <div className="row" style={{ gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
                  <button
                    className="btn"
                    style={{ fontSize: 12 }}
                    onClick={() => generateAsk(c)}
                    disabled={generating[c.id] || isLogged}
                  >
                    {generating[c.id] ? "Generating…" : "Generate Ask"}
                  </button>
                  <button
                    className="btn btnPrimary"
                    style={{ fontSize: 12 }}
                    onClick={() => setLogNoteOpen(prev => ({ ...prev, [c.id]: !prev[c.id] }))}
                    disabled={logging[c.id] || isLogged}
                  >
                    Log Ask Sent
                  </button>
                </div>
              </div>

              {/* Draft panel */}
              {draftOpen[c.id] && (
                <div style={{ borderTop: "1px solid rgba(0,0,0,.07)", paddingTop: 10 }}>
                  {generating[c.id] ? (
                    <div style={{ height: 60, borderRadius: 6, background: "rgba(18,18,18,.06)", animation: "pulse 1.4s ease-in-out infinite" }} />
                  ) : (
                    <div className="stack" style={{ gap: 8 }}>
                      <div className="label">Draft message</div>
                      <textarea
                        className="textarea"
                        value={drafts[c.id] ?? ""}
                        onChange={e => setDrafts(prev => ({ ...prev, [c.id]: e.target.value }))}
                        rows={4}
                        style={{ fontSize: 14 }}
                      />
                      <div className="row" style={{ gap: 6 }}>
                        <button
                          className="btn"
                          style={{ fontSize: 12 }}
                          onClick={() => {
                            if (drafts[c.id]) navigator.clipboard.writeText(drafts[c.id]);
                          }}
                        >
                          Copy
                        </button>
                        <button
                          className="btn"
                          style={{ fontSize: 12, color: "rgba(18,18,18,.4)" }}
                          onClick={() => setDraftOpen(prev => ({ ...prev, [c.id]: false }))}
                        >
                          Close
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Log ask panel */}
              {logNoteOpen[c.id] && (
                <div style={{ borderTop: "1px solid rgba(0,0,0,.07)", paddingTop: 10 }}>
                  <div className="stack" style={{ gap: 8 }}>
                    <div className="label">Add note (optional)</div>
                    <input
                      className="input"
                      value={logNotes[c.id] ?? ""}
                      onChange={e => setLogNotes(prev => ({ ...prev, [c.id]: e.target.value }))}
                      placeholder="e.g. Sent via text, they seemed receptive"
                    />
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        className="btn btnPrimary"
                        style={{ fontSize: 12 }}
                        onClick={() => logAsk(c)}
                        disabled={logging[c.id]}
                      >
                        {logging[c.id] ? "Saving…" : "Confirm Ask Sent"}
                      </button>
                      <button
                        className="btn"
                        style={{ fontSize: 12 }}
                        onClick={() => setLogNoteOpen(prev => ({ ...prev, [c.id]: false }))}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
