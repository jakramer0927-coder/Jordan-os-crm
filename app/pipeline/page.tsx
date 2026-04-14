"use client";

import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

type DealStage = "lead" | "showing" | "offer_in" | "under_contract" | "closed_won" | "closed_lost";

const ACTIVE_STAGES: { value: DealStage; label: string }[] = [
  { value: "lead",           label: "Lead" },
  { value: "showing",        label: "Showing" },
  { value: "offer_in",       label: "Offer In" },
  { value: "under_contract", label: "Under Contract" },
];

const ALL_STAGES: { value: DealStage; label: string }[] = [
  ...ACTIVE_STAGES,
  { value: "closed_won",  label: "Closed ✓" },
  { value: "closed_lost", label: "Closed ✗" },
];

function stageColor(s: string): React.CSSProperties {
  if (s === "closed_won")     return { background: "rgba(11,107,42,.1)",   color: "#0b6b2a",           borderColor: "rgba(11,107,42,.25)" };
  if (s === "closed_lost")    return { background: "rgba(0,0,0,.05)",       color: "rgba(18,18,18,.4)", borderColor: "transparent" };
  if (s === "under_contract") return { background: "rgba(11,60,140,.08)",   color: "#1a3f8a",           borderColor: "rgba(11,60,140,.2)" };
  if (s === "offer_in")       return { background: "rgba(120,60,0,.08)",    color: "rgba(120,60,0,.9)", borderColor: "rgba(120,60,0,.2)" };
  return {};
}

type PipelineDeal = {
  id: string;
  address: string;
  role: string;
  status: DealStage;
  price: number | null;
  close_date: string | null;
  notes: string | null;
  created_at: string;
  stage_entered_at: string | null;
  contact: { id: string; display_name: string; category: string; tier: string | null } | null;
  referral_source: { id: string; display_name: string } | null;
};

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

function fmtPrice(p: number | null) {
  if (p == null) return null;
  return `$${p.toLocaleString()}`;
}

function fmtDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function PipelinePage() {
  const [ready, setReady] = useState(false);
  const [deals, setDeals] = useState<PipelineDeal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const { data } = await supabase.auth.getSession();
    if (!data.session) { window.location.href = "/login"; return; }

    const params = showClosed ? "?include_closed=1" : "";
    const res = await fetch(`/api/pipeline${params}`);
    const j = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) { setError(j?.error || "Failed to load"); return; }
    setDeals((j.deals ?? []) as PipelineDeal[]);
  }

  async function updateStage(dealId: string, newStage: DealStage) {
    setUpdatingId(dealId);
    const deal = deals.find(d => d.id === dealId);
    if (!deal) return;
    const res = await fetch("/api/contacts/deals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: dealId,
        contact_id: deal.contact?.id,
        address: deal.address,
        role: deal.role,
        status: newStage,
        price: deal.price,
        close_date: deal.close_date,
        notes: deal.notes,
        referral_source_contact_id: deal.referral_source?.id ?? null,
      }),
    });
    if (res.ok) {
      setDeals(prev => prev.map(d => d.id === dealId ? { ...d, status: newStage } : d));
    }
    setUpdatingId(null);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { window.location.href = "/login"; return; }
      setReady(true);
      load();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showClosed]);

  const byStage = useMemo(() => {
    const stages = showClosed ? ALL_STAGES : ACTIVE_STAGES;
    return stages.map(s => ({
      ...s,
      deals: deals.filter(d => d.status === s.value),
    }));
  }, [deals, showClosed]);

  const totalValue = useMemo(() =>
    deals.filter(d => d.price != null && d.status !== "closed_lost")
      .reduce((sum, d) => sum + (d.price ?? 0), 0),
    [deals]
  );

  const activeCount = deals.filter(d => !["closed_won", "closed_lost"].includes(d.status)).length;

  if (!ready) return <div className="page">Loading…</div>;

  return (
    <div className="stack">
      {/* Header */}
      <div className="rowBetween" style={{ flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="h1">Pipeline</h1>
          <div className="subtle" style={{ marginTop: 6 }}>
            {activeCount} active deal{activeCount !== 1 ? "s" : ""}
            {totalValue > 0 && <span> · {fmtPrice(totalValue)} total value</span>}
          </div>
        </div>
        <div className="row">
          <button
            className="btn"
            style={{ fontSize: 12 }}
            onClick={() => setShowClosed(v => !v)}
          >
            {showClosed ? "Hide closed" : "Show closed"}
          </button>
          <button className="btn" onClick={load} disabled={loading}>Refresh</button>
          <a className="btn" href="/contacts" style={{ textDecoration: "none" }}>Contacts</a>
        </div>
      </div>

      {error && <div className="alert alertError">{error}</div>}

      {deals.length === 0 && !loading && (
        <div className="card cardPad">
          <div className="subtle">No active deals. Add deals from a contact's detail page.</div>
        </div>
      )}

      {/* Stage columns */}
      {byStage.map(stage => (
        stage.deals.length === 0 ? null : (
          <div key={stage.value} className="card cardPad stack">
            <div className="rowBetween" style={{ alignItems: "center" }}>
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <span className="badge" style={stageColor(stage.value)}>{stage.label}</span>
                <span className="subtle" style={{ fontSize: 12 }}>{stage.deals.length} deal{stage.deals.length !== 1 ? "s" : ""}</span>
                {(() => {
                  const stageValue = stage.deals.reduce((s, d) => s + (d.price ?? 0), 0);
                  return stageValue > 0 ? <span className="subtle" style={{ fontSize: 12 }}>· {fmtPrice(stageValue)}</span> : null;
                })()}
              </div>
            </div>

            <div className="stack" style={{ gap: 0 }}>
              {stage.deals.map((d, i) => {
                const daysInStage = daysSince(d.stage_entered_at ?? d.created_at);
                const daysToClose = d.close_date ? daysSince(d.close_date) : null;
                const closeOverdue = daysToClose != null && daysToClose < 0; // negative = in the future
                const closeSoon = d.close_date && !closeOverdue && daysToClose != null && daysToClose >= 0 && daysToClose <= 7;

                return (
                  <div
                    key={d.id}
                    style={{
                      padding: "14px 0",
                      borderBottom: i < stage.deals.length - 1 ? "1px solid rgba(0,0,0,.06)" : undefined,
                      display: "flex",
                      gap: 16,
                      alignItems: "flex-start",
                      flexWrap: "wrap",
                    }}
                  >
                    {/* Main info */}
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <div style={{ fontWeight: 900, fontSize: 15, wordBreak: "break-word" }}>{d.address}</div>

                      <div className="row" style={{ marginTop: 6, flexWrap: "wrap", gap: 4 }}>
                        <span className="badge" style={{ textTransform: "capitalize" }}>{d.role}</span>
                        {d.price != null && <span className="badge">{fmtPrice(d.price)}</span>}
                        {d.close_date && (
                          <span
                            className="badge"
                            style={
                              closeOverdue
                                ? { color: "#8a0000", borderColor: "rgba(200,0,0,.25)", background: "rgba(200,0,0,.05)", fontWeight: 700 }
                                : closeSoon
                                ? { color: "rgba(120,60,0,.9)", borderColor: "rgba(120,60,0,.2)", background: "rgba(120,60,0,.06)" }
                                : {}
                            }
                          >
                            Close {fmtDate(d.close_date)}
                            {closeOverdue ? " ⚠ overdue" : closeSoon ? " · soon" : ""}
                          </span>
                        )}
                        {daysInStage != null && (
                          <span className="badge" style={daysInStage > 30 ? { color: "#8a0000" } : {}}>
                            {daysInStage}d in stage
                          </span>
                        )}
                      </div>

                      {/* Contact + referral */}
                      <div style={{ marginTop: 8, fontSize: 13 }}>
                        {d.contact && (
                          <span>
                            <a href={`/contacts/${d.contact.id}`} style={{ fontWeight: 700 }}>
                              {d.contact.display_name}
                            </a>
                            <span className="subtle"> · {d.contact.category}{d.contact.tier ? ` Tier ${d.contact.tier}` : ""}</span>
                          </span>
                        )}
                        {d.referral_source && (
                          <span className="subtle" style={{ marginLeft: 10 }}>
                            via{" "}
                            <a href={`/contacts/${d.referral_source.id}`} style={{ fontWeight: 700 }}>
                              {d.referral_source.display_name}
                            </a>
                          </span>
                        )}
                      </div>

                      {d.notes && (
                        <div className="subtle" style={{ fontSize: 12, marginTop: 6 }}>{d.notes}</div>
                      )}
                    </div>

                    {/* Stage mover */}
                    <div className="stack" style={{ gap: 4, flexShrink: 0, minWidth: 140 }}>
                      <div className="label" style={{ fontSize: 10, marginBottom: 2 }}>Move to stage</div>
                      {ALL_STAGES.filter(s => s.value !== d.status).map(s => (
                        <button
                          key={s.value}
                          className="btn"
                          style={{ fontSize: 11, padding: "2px 8px", textAlign: "left", justifyContent: "flex-start", ...stageColor(s.value) }}
                          onClick={() => updateStage(d.id, s.value)}
                          disabled={updatingId === d.id}
                        >
                          {s.label}
                        </button>
                      ))}
                      <a
                        href={d.contact ? `/contacts/${d.contact.id}` : "#"}
                        className="btn"
                        style={{ fontSize: 11, padding: "2px 8px", marginTop: 4, textDecoration: "none" }}
                      >
                        Open contact →
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )
      ))}
    </div>
  );
}
