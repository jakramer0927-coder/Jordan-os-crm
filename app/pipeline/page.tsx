"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

type DealStage = "lead" | "showing" | "offer_in" | "under_contract" | "closed_won" | "closed_lost";

const STAGES: { value: DealStage; label: string; color: string; bg: string }[] = [
  { value: "lead",           label: "Lead",            color: "rgba(18,18,18,.5)",  bg: "rgba(0,0,0,.03)" },
  { value: "showing",        label: "Showing",         color: "rgba(18,18,18,.7)",  bg: "rgba(0,0,0,.04)" },
  { value: "offer_in",       label: "Offer In",        color: "rgba(120,60,0,.9)",  bg: "rgba(120,60,0,.06)" },
  { value: "under_contract", label: "Under Contract",  color: "#1a3f8a",            bg: "rgba(11,60,140,.06)" },
  { value: "closed_won",     label: "Closed ✓",        color: "#0b6b2a",            bg: "rgba(11,107,42,.06)" },
  { value: "closed_lost",    label: "Closed ✗",        color: "rgba(18,18,18,.35)", bg: "rgba(0,0,0,.02)" },
];

const ACTIVE_STAGES = STAGES.filter(s => s.value !== "closed_won" && s.value !== "closed_lost");

type Deal = {
  id: string;
  address: string;
  role: string;
  status: DealStage;
  price: number | null;
  close_date: string | null;
  notes: string | null;
  created_at: string;
  contact_id: string;
  contacts: { id: string; display_name: string; category: string; tier: string | null; phone: string | null; email: string | null } | null;
  referral_source: { id: string; display_name: string } | null;
};

function fmt(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n.toLocaleString()}`;
}

function daysInStage(createdAt: string) {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000);
}

function closeDateLabel(dateStr: string | null) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const days = Math.ceil((d.getTime() - Date.now()) / 86400000);
  const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (days < 0) return { label: `${label} (${Math.abs(days)}d overdue)`, overdue: true };
  if (days === 0) return { label: "Closes today", overdue: false };
  if (days <= 7) return { label: `${label} (${days}d)`, overdue: false };
  return { label, overdue: false };
}

export default function PipelinePage() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [listView, setListView] = useState(false);
  const [movingDeal, setMovingDeal] = useState<Deal | null>(null);
  const [movingTo, setMovingTo] = useState<DealStage | "">("");
  const [saving, setSaving] = useState(false);
  // Edit fields inside the deal modal
  const [editAddress, setEditAddress] = useState("");
  const [editRole, setEditRole] = useState("buyer");
  const [editPrice, setEditPrice] = useState("");
  const [editCloseDate, setEditCloseDate] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editRefQuery, setEditRefQuery] = useState("");
  const [editRefResults, setEditRefResults] = useState<{ id: string; display_name: string; category: string }[]>([]);
  const [editRefId, setEditRefId] = useState("");
  const [editRefName, setEditRefName] = useState("");
  const [editTab, setEditTab] = useState<"stage" | "details" | "activity">("stage");
  // Activity log
  type DealActivity = { id: string; note: string; activity_type: string; occurred_at: string };
  const [activities, setActivities] = useState<DealActivity[]>([]);
  const [activityNote, setActivityNote] = useState("");
  const [activityType, setActivityType] = useState("note");
  const [activityLoading, setActivityLoading] = useState(false);
  const [activitySaving, setActivitySaving] = useState(false);

  // New deal modal
  const [newDealOpen, setNewDealOpen] = useState(false);
  const [ndContactQuery, setNdContactQuery] = useState("");
  const [ndContactResults, setNdContactResults] = useState<{ id: string; display_name: string; category: string; tier: string | null }[]>([]);
  const [ndContactId, setNdContactId] = useState("");
  const [ndContactName, setNdContactName] = useState("");
  const [ndAddress, setNdAddress] = useState("");
  const [ndRole, setNdRole] = useState("buyer");
  const [ndStatus, setNdStatus] = useState<DealStage>("lead");
  const [ndPrice, setNdPrice] = useState("");
  const [ndCloseDate, setNdCloseDate] = useState("");
  const [ndNotes, setNdNotes] = useState("");
  const [ndRefQuery, setNdRefQuery] = useState("");
  const [ndRefResults, setNdRefResults] = useState<{ id: string; display_name: string; category: string }[]>([]);
  const [ndRefId, setNdRefId] = useState("");
  const [ndRefName, setNdRefName] = useState("");
  const [ndSaving, setNdSaving] = useState(false);
  const [ndError, setNdError] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase.auth.getSession();
    if (!data.session) { window.location.href = "/login"; return; }

    setLoading(true);
    const res = await fetch("/api/pipeline?include_closed=1");
    const j = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) { setError(j.error ?? "Load failed"); return; }
    setDeals(j.deals ?? []);
  }

  function openDealModal(deal: Deal) {
    setMovingDeal(deal);
    setMovingTo(deal.status);
    setEditAddress(deal.address);
    setEditRole(deal.role);
    setEditPrice(deal.price != null ? String(deal.price) : "");
    setEditCloseDate(deal.close_date ?? "");
    setEditNotes(deal.notes ?? "");
    setEditRefId(deal.referral_source?.id ?? "");
    setEditRefName(deal.referral_source?.display_name ?? "");
    setEditRefQuery(deal.referral_source?.display_name ?? "");
    setEditRefResults([]);
    setEditTab("stage");
    setActivities([]);
    setActivityNote("");
    setActivityType("note");
    loadActivities(deal.id);
  }

  async function loadActivities(dealId: string) {
    setActivityLoading(true);
    const res = await fetch(`/api/deals/activity?deal_id=${dealId}`);
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      setActivities(j.activities ?? []);
    }
    setActivityLoading(false);
  }

  async function addActivity() {
    if (!movingDeal || !activityNote.trim()) return;
    setActivitySaving(true);
    const res = await fetch("/api/deals/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deal_id: movingDeal.id, note: activityNote.trim(), activity_type: activityType }),
    });
    setActivitySaving(false);
    if (!res.ok) return;
    const j = await res.json().catch(() => ({}));
    setActivities(prev => [j.activity, ...prev]);
    setActivityNote("");
  }

  async function deleteActivity(id: string) {
    await fetch("/api/deals/activity", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setActivities(prev => prev.filter(a => a.id !== id));
  }

  async function saveDeal() {
    if (!movingDeal) return;
    setSaving(true);
    const res = await fetch("/api/pipeline", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: movingDeal.id,
        status: movingTo || movingDeal.status,
        address: editAddress.trim(),
        role: editRole,
        price: editPrice ? Number(editPrice.replace(/[^0-9.]/g, "")) : null,
        close_date: editCloseDate || null,
        notes: editNotes.trim() || null,
        referral_source_contact_id: editRefId || null,
      }),
    });
    setSaving(false);
    if (!res.ok) return;
    // Reload to get fresh joined data
    load();
    setMovingDeal(null);
    setMovingTo("");
  }

  async function searchEditRef(q: string) {
    setEditRefQuery(q);
    setEditRefId("");
    setEditRefName("");
    if (!q.trim() || q.trim().length < 2) { setEditRefResults([]); return; }
    const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(q.trim())}`);
    const j = await res.json().catch(() => ({}));
    setEditRefResults(res.ok ? (j.results ?? []) : []);
  }

  async function searchContacts(q: string) {
    setNdContactQuery(q);
    setNdContactId("");
    setNdContactName("");
    if (!q.trim() || q.trim().length < 2) { setNdContactResults([]); return; }
    const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(q.trim())}`);
    const j = await res.json().catch(() => ({}));
    setNdContactResults(res.ok ? (j.results ?? []) : []);
  }

  async function searchRefSource(q: string) {
    setNdRefQuery(q);
    setNdRefId("");
    setNdRefName("");
    if (!q.trim() || q.trim().length < 2) { setNdRefResults([]); return; }
    const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(q.trim())}`);
    const j = await res.json().catch(() => ({}));
    setNdRefResults(res.ok ? (j.results ?? []) : []);
  }

  function openNewDeal() {
    setNdContactQuery(""); setNdContactResults([]); setNdContactId(""); setNdContactName("");
    setNdAddress(""); setNdRole("buyer"); setNdStatus("lead");
    setNdPrice(""); setNdCloseDate(""); setNdNotes("");
    setNdRefQuery(""); setNdRefResults([]); setNdRefId(""); setNdRefName("");
    setNdError(null);
    setNewDealOpen(true);
  }

  async function saveNewDeal() {
    if (!ndContactId) { setNdError("Select a contact first."); return; }
    if (!ndAddress.trim()) { setNdError("Address is required."); return; }
    setNdSaving(true);
    setNdError(null);
    const res = await fetch("/api/contacts/deals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contact_id: ndContactId,
        address: ndAddress.trim(),
        role: ndRole,
        status: ndStatus,
        price: ndPrice ? Number(ndPrice.replace(/[^0-9.]/g, "")) : null,
        close_date: ndCloseDate || null,
        notes: ndNotes.trim() || null,
        referral_source_contact_id: ndRefId || null,
      }),
    });
    const j = await res.json().catch(() => ({}));
    setNdSaving(false);
    if (!res.ok) { setNdError(j?.error || "Save failed"); return; }
    setNewDealOpen(false);
    load();
  }

  useEffect(() => { load(); }, []);

  const activeDeals = deals.filter(d => d.status !== "closed_won" && d.status !== "closed_lost");
  const closedDeals = deals.filter(d => d.status === "closed_won" || d.status === "closed_lost");
  const totalPipelineValue = activeDeals.reduce((sum, d) => sum + (d.price ?? 0), 0);
  const totalClosedValue = closedDeals.filter(d => d.status === "closed_won").reduce((sum, d) => sum + (d.price ?? 0), 0);

  const dealsByStage = (stage: DealStage) => deals.filter(d => d.status === stage);
  const stageValue = (stage: DealStage) => dealsByStage(stage).reduce((sum, d) => sum + (d.price ?? 0), 0);

  const visibleStages = showClosed ? STAGES : ACTIVE_STAGES;

  if (loading) return <div className="card cardPad">Loading…</div>;

  return (
    <div className="stack">
      {/* Header */}
      <div className="card cardPad">
        <div className="rowBetween" style={{ alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 className="h1" style={{ margin: 0 }}>Pipeline</h1>
            <div className="subtle" style={{ marginTop: 6, fontSize: 13 }}>
              {activeDeals.length} active deal{activeDeals.length !== 1 ? "s" : ""}
              {totalPipelineValue > 0 && <> · <strong>{fmt(totalPipelineValue)}</strong> in pipeline</>}
              {totalClosedValue > 0 && <> · <strong style={{ color: "#0b6b2a" }}>{fmt(totalClosedValue)}</strong> closed</>}
            </div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="btn btnPrimary" style={{ fontSize: 12 }} onClick={openNewDeal}>+ New deal</button>
            <button className="btn" style={{ fontSize: 12 }} onClick={() => setListView(v => !v)}>
              {listView ? "Board" : "List"}
            </button>
            <button className="btn" style={{ fontSize: 12 }} onClick={() => setShowClosed(v => !v)}>
              {showClosed ? "Hide closed" : "Show closed"}
            </button>
            <a className="btn" href="/morning" style={{ fontSize: 12, textDecoration: "none" }}>Morning</a>
            <a className="btn" href="/contacts" style={{ fontSize: 12, textDecoration: "none" }}>Contacts</a>
          </div>
        </div>
        {error && <div className="alert alertError" style={{ marginTop: 10 }}>{error}</div>}
      </div>

      {/* Kanban / List */}
      {activeDeals.length === 0 && !showClosed ? (
        <div className="card cardPad">
          <div className="subtle" style={{ fontSize: 14 }}>No active deals. Click "+ New deal" to get started.</div>
        </div>
      ) : listView ? (
        /* ── List view ── */
        <div className="stack" style={{ gap: 0 }}>
          {visibleStages.map(stage => {
            const stageDeals = dealsByStage(stage.value);
            if (stageDeals.length === 0) return null;
            return (
              <div key={stage.value}>
                <div style={{ padding: "8px 12px", background: stage.bg, borderRadius: 8, marginBottom: 6, fontWeight: 900, fontSize: 13, color: stage.color }}>
                  {stage.label} · {stageDeals.length} deal{stageDeals.length !== 1 ? "s" : ""}
                  {stageValue(stage.value) > 0 && <span style={{ fontWeight: 400, marginLeft: 6 }}>{fmt(stageValue(stage.value))}</span>}
                </div>
                <div className="stack" style={{ gap: 6, marginBottom: 14 }}>
                  {stageDeals.map(deal => {
                    const close = closeDateLabel(deal.close_date);
                    return (
                      <div key={deal.id} className="card cardPad" style={{ cursor: "pointer", padding: "10px 14px" }} onClick={() => openDealModal(deal)}>
                        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 800, fontSize: 13 }}>{deal.address}</div>
                            {deal.contacts && (
                              <a href={`/contacts/${deal.contacts.id}`} style={{ fontSize: 12, color: "rgba(18,18,18,.6)", textDecoration: "none", fontWeight: 700 }} onClick={e => e.stopPropagation()}>
                                {deal.contacts.display_name}
                              </a>
                            )}
                          </div>
                          <div className="row" style={{ gap: 4, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
                            <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "rgba(0,0,0,.05)", textTransform: "capitalize" }}>{deal.role}</span>
                            {deal.price && <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "rgba(0,0,0,.05)", fontWeight: 700 }}>{fmt(deal.price)}</span>}
                            {close && <span style={{ fontSize: 11, fontWeight: 700, color: close.overdue ? "#8a0000" : "#92610a" }}>{close.label}</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ── Board view ── */
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${visibleStages.length}, minmax(220px, 1fr))`, gap: 12, overflowX: "auto" }}>
          {visibleStages.map(stage => {
            const stageDeals = dealsByStage(stage.value);
            const val = stageValue(stage.value);
            return (
              <div key={stage.value} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {/* Column header */}
                <div style={{ padding: "8px 12px", borderRadius: 8, background: stage.bg, border: `1px solid ${stage.color}22` }}>
                  <div style={{ fontWeight: 900, fontSize: 13, color: stage.color }}>{stage.label}</div>
                  <div style={{ fontSize: 12, color: stage.color, opacity: 0.8, marginTop: 2 }}>
                    {stageDeals.length} deal{stageDeals.length !== 1 ? "s" : ""}
                    {val > 0 && <> · {fmt(val)}</>}
                  </div>
                </div>

                {/* Cards */}
                {stageDeals.length === 0 ? (
                  <div style={{ padding: "16px 12px", borderRadius: 8, border: "1px dashed rgba(0,0,0,.12)", fontSize: 13, color: "rgba(18,18,18,.3)", textAlign: "center" }}>
                    Empty
                  </div>
                ) : stageDeals.map(deal => {
                  const close = closeDateLabel(deal.close_date);
                  const days = daysInStage(deal.created_at);
                  return (
                    <div
                      key={deal.id}
                      className="card cardPad"
                      style={{ cursor: "pointer", padding: "12px 14px", transition: "box-shadow .15s" }}
                      onClick={() => openDealModal(deal)}
                    >
                      {/* Address */}
                      <div style={{ fontWeight: 800, fontSize: 13, lineHeight: 1.3, marginBottom: 6 }}>{deal.address}</div>

                      {/* Contact */}
                      {deal.contacts && (
                        <a
                          href={`/contacts/${deal.contacts.id}`}
                          style={{ fontSize: 12, fontWeight: 700, color: "rgba(18,18,18,.65)", textDecoration: "none", display: "block", marginBottom: 6 }}
                          onClick={e => e.stopPropagation()}
                        >
                          {deal.contacts.display_name}
                          {deal.contacts.tier && <span style={{ fontWeight: 400, marginLeft: 4 }}>· Tier {deal.contacts.tier}</span>}
                        </a>
                      )}

                      {/* Badges */}
                      <div className="row" style={{ flexWrap: "wrap", gap: 4, marginBottom: 4 }}>
                        <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "rgba(0,0,0,.05)", textTransform: "capitalize" }}>{deal.role}</span>
                        {deal.price && <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "rgba(0,0,0,.05)", fontWeight: 700 }}>{fmt(deal.price)}</span>}
                        {deal.referral_source && (
                          <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "rgba(120,60,0,.07)", color: "rgba(120,60,0,.8)" }}>
                            Ref: {deal.referral_source.display_name}
                          </span>
                        )}
                      </div>

                      {/* Close date */}
                      {close && (
                        <div style={{ fontSize: 11, fontWeight: 700, color: close.overdue ? "#8a0000" : "#92610a", marginTop: 4 }}>
                          {close.overdue ? "⚠ " : "📅 "}{close.label}
                        </div>
                      )}

                      {/* Days in pipeline */}
                      <div style={{ fontSize: 11, color: "rgba(18,18,18,.35)", marginTop: 6 }}>
                        {days}d in pipeline
                      </div>

                      {deal.notes && (
                        <div style={{ fontSize: 11, color: "rgba(18,18,18,.45)", marginTop: 6, lineHeight: 1.4, borderTop: "1px solid rgba(0,0,0,.07)", paddingTop: 6 }}>
                          {deal.notes.length > 80 ? deal.notes.slice(0, 80) + "…" : deal.notes}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {/* New deal modal */}
      {newDealOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 999, overflowY: "auto" }}>
          <div className="card cardPad" style={{ width: "min(540px, 100%)", maxHeight: "90vh", overflowY: "auto" }}>
            <div style={{ fontWeight: 900, fontSize: 17, marginBottom: 16 }}>New deal</div>

            {ndError && <div style={{ color: "#8a0000", fontSize: 13, fontWeight: 700, marginBottom: 12 }}>{ndError}</div>}

            {/* Contact search */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Contact *</div>
              {ndContactId ? (
                <div className="row" style={{ gap: 8 }}>
                  <div style={{ fontWeight: 800, fontSize: 14, flex: 1 }}>{ndContactName}</div>
                  <button className="btn" style={{ fontSize: 11 }} onClick={() => { setNdContactId(""); setNdContactName(""); setNdContactQuery(""); }}>Change</button>
                </div>
              ) : (
                <>
                  <input
                    className="input"
                    placeholder="Search by name…"
                    value={ndContactQuery}
                    onChange={e => searchContacts(e.target.value)}
                    autoFocus
                  />
                  {ndContactResults.length > 0 && (
                    <div style={{ marginTop: 4, border: "1px solid rgba(0,0,0,.1)", borderRadius: 6, overflow: "hidden" }}>
                      {ndContactResults.slice(0, 6).map(r => (
                        <div
                          key={r.id}
                          style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid rgba(0,0,0,.06)" }}
                          onClick={() => { setNdContactId(r.id); setNdContactName(r.display_name); setNdContactResults([]); setNdContactQuery(""); }}
                        >
                          <strong>{r.display_name}</strong>
                          <span style={{ marginLeft: 8, color: "rgba(18,18,18,.45)", fontSize: 12 }}>{r.category}{r.tier ? ` · Tier ${r.tier}` : ""}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Address */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Address *</div>
              <input className="input" placeholder="123 Main St" value={ndAddress} onChange={e => setNdAddress(e.target.value)} />
            </div>

            {/* Role + Stage */}
            <div className="row" style={{ gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 120 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Role</div>
                <select className="select" value={ndRole} onChange={e => setNdRole(e.target.value)}>
                  <option value="buyer">Buyer</option>
                  <option value="seller">Seller</option>
                  <option value="landlord">Landlord</option>
                  <option value="tenant">Tenant</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Stage</div>
                <select className="select" value={ndStatus} onChange={e => setNdStatus(e.target.value as DealStage)}>
                  {STAGES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            </div>

            {/* Price + Close date */}
            <div className="row" style={{ gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 120 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Price</div>
                <input className="input" placeholder="e.g. 2500000" value={ndPrice} onChange={e => setNdPrice(e.target.value)} />
              </div>
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Expected close date</div>
                <input className="input" type="date" value={ndCloseDate} onChange={e => setNdCloseDate(e.target.value)} />
              </div>
            </div>

            {/* Referral source */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Referral source (optional)</div>
              {ndRefId ? (
                <div className="row" style={{ gap: 8 }}>
                  <div style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>{ndRefName}</div>
                  <button className="btn" style={{ fontSize: 11 }} onClick={() => { setNdRefId(""); setNdRefName(""); setNdRefQuery(""); }}>Clear</button>
                </div>
              ) : (
                <>
                  <input className="input" placeholder="Search contact…" value={ndRefQuery} onChange={e => searchRefSource(e.target.value)} />
                  {ndRefResults.length > 0 && (
                    <div style={{ marginTop: 4, border: "1px solid rgba(0,0,0,.1)", borderRadius: 6, overflow: "hidden" }}>
                      {ndRefResults.slice(0, 4).map(r => (
                        <div
                          key={r.id}
                          style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid rgba(0,0,0,.06)" }}
                          onClick={() => { setNdRefId(r.id); setNdRefName(r.display_name); setNdRefResults([]); setNdRefQuery(""); }}
                        >
                          <strong>{r.display_name}</strong>
                          <span style={{ marginLeft: 8, color: "rgba(18,18,18,.45)", fontSize: 12 }}>{r.category}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Notes */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Notes</div>
              <textarea className="textarea" rows={3} placeholder="Any context on this deal…" value={ndNotes} onChange={e => setNdNotes(e.target.value)} />
            </div>

            <div className="row" style={{ gap: 8 }}>
              <button className="btn btnPrimary" onClick={saveNewDeal} disabled={ndSaving}>
                {ndSaving ? "Saving…" : "Create deal"}
              </button>
              <button className="btn" onClick={() => setNewDealOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Deal edit modal */}
      {movingDeal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 999, overflowY: "auto" }}>
          <div className="card cardPad" style={{ width: "min(520px, 100%)", maxHeight: "90vh", overflowY: "auto" }}>
            {/* Header */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 900, fontSize: 16 }}>{movingDeal.address}</div>
              {movingDeal.contacts && (
                <div className="subtle" style={{ fontSize: 13, marginTop: 2 }}>{movingDeal.contacts.display_name}</div>
              )}
            </div>

            {/* Tabs */}
            <div className="row" style={{ gap: 0, marginBottom: 16, borderBottom: "2px solid rgba(0,0,0,.08)" }}>
              {(["stage", "details", "activity"] as const).map(tab => (
                <button key={tab} onClick={() => setEditTab(tab)} style={{ padding: "6px 16px", fontWeight: editTab === tab ? 900 : 500, fontSize: 13, background: "none", border: "none", cursor: "pointer", borderBottom: editTab === tab ? "2px solid var(--ink)" : "2px solid transparent", marginBottom: -2, color: editTab === tab ? "var(--ink)" : "rgba(18,18,18,.45)", textTransform: "capitalize" }}>
                  {tab}{tab === "activity" && activities.length > 0 ? ` (${activities.length})` : ""}
                </button>
              ))}
            </div>

            {editTab === "stage" && (
              <div className="stack" style={{ gap: 6, marginBottom: 16 }}>
                {STAGES.map(s => (
                  <button key={s.value} onClick={() => setMovingTo(s.value)} style={{ padding: "10px 14px", borderRadius: 8, border: movingTo === s.value ? `2px solid ${s.color}` : "1px solid rgba(0,0,0,.1)", background: movingTo === s.value ? s.bg : "transparent", color: s.color, fontWeight: movingTo === s.value ? 900 : 500, fontSize: 14, cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}>
                    {movingTo === s.value && <span style={{ fontWeight: 900 }}>✓</span>}
                    {s.label}
                    {s.value === movingDeal.status && <span style={{ fontSize: 11, opacity: 0.6, marginLeft: "auto" }}>current</span>}
                  </button>
                ))}
              </div>
            )}

            {editTab === "details" && (
              <div className="stack" style={{ gap: 14, marginBottom: 16 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Address</div>
                  <input className="input" value={editAddress} onChange={e => setEditAddress(e.target.value)} />
                </div>
                <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 120 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Role</div>
                    <select className="select" value={editRole} onChange={e => setEditRole(e.target.value)}>
                      <option value="buyer">Buyer</option>
                      <option value="seller">Seller</option>
                      <option value="landlord">Landlord</option>
                      <option value="tenant">Tenant</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div style={{ flex: 1, minWidth: 120 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Price</div>
                    <input className="input" placeholder="e.g. 2500000" value={editPrice} onChange={e => setEditPrice(e.target.value)} />
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Expected close date</div>
                  <input className="input" type="date" value={editCloseDate} onChange={e => setEditCloseDate(e.target.value)} />
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Referral source</div>
                  {editRefId ? (
                    <div className="row" style={{ gap: 8 }}>
                      <span style={{ fontWeight: 700, fontSize: 13, flex: 1 }}>{editRefName}</span>
                      <button className="btn" style={{ fontSize: 11 }} onClick={() => { setEditRefId(""); setEditRefName(""); setEditRefQuery(""); }}>Clear</button>
                    </div>
                  ) : (
                    <>
                      <input className="input" placeholder="Search contact…" value={editRefQuery} onChange={e => searchEditRef(e.target.value)} />
                      {editRefResults.length > 0 && (
                        <div style={{ marginTop: 4, border: "1px solid rgba(0,0,0,.1)", borderRadius: 6, overflow: "hidden" }}>
                          {editRefResults.slice(0, 4).map(r => (
                            <div key={r.id} style={{ padding: "8px 12px", cursor: "pointer", fontSize: 13, borderBottom: "1px solid rgba(0,0,0,.06)" }} onClick={() => { setEditRefId(r.id); setEditRefName(r.display_name); setEditRefResults([]); setEditRefQuery(r.display_name); }}>
                              <strong>{r.display_name}</strong>
                              <span style={{ marginLeft: 8, color: "rgba(18,18,18,.45)", fontSize: 12 }}>{r.category}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Notes</div>
                  <textarea className="textarea" rows={3} value={editNotes} onChange={e => setEditNotes(e.target.value)} />
                </div>
              </div>
            )}

            {editTab === "activity" && (
              <div style={{ marginBottom: 16 }}>
                {/* Add entry */}
                <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                  <select className="select" value={activityType} onChange={e => setActivityType(e.target.value)} style={{ width: 150, flexShrink: 0 }}>
                    <option value="note">Note</option>
                    <option value="showing_feedback">Showing feedback</option>
                    <option value="offer">Offer</option>
                    <option value="price_change">Price change</option>
                    <option value="status_change">Status change</option>
                    <option value="other">Other</option>
                  </select>
                  <input
                    className="input"
                    style={{ flex: 1, minWidth: 160 }}
                    placeholder="Add a note…"
                    value={activityNote}
                    onChange={e => setActivityNote(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && addActivity()}
                  />
                  <button className="btn btnPrimary" onClick={addActivity} disabled={activitySaving || !activityNote.trim()} style={{ flexShrink: 0 }}>
                    {activitySaving ? "…" : "Add"}
                  </button>
                </div>

                {/* Log */}
                {activityLoading ? (
                  <div className="subtle" style={{ fontSize: 13 }}>Loading…</div>
                ) : activities.length === 0 ? (
                  <div className="subtle" style={{ fontSize: 13 }}>No activity yet. Add notes, showing feedback, offers, and price changes here.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                    {activities.map((a, i) => {
                      const typeLabel: Record<string, string> = { note: "Note", showing_feedback: "Showing", offer: "Offer", price_change: "Price", status_change: "Status", other: "Other" };
                      const typeColor: Record<string, string> = { offer: "#1a3f8a", price_change: "#92610a", showing_feedback: "#0b6b2a", status_change: "#5a2d8a", note: "rgba(18,18,18,.5)", other: "rgba(18,18,18,.5)" };
                      return (
                        <div key={a.id} style={{ padding: "10px 0", borderBottom: i < activities.length - 1 ? "1px solid rgba(0,0,0,.06)" : undefined, display: "flex", gap: 10, alignItems: "flex-start" }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 3 }}>
                              <span style={{ fontSize: 11, fontWeight: 800, color: typeColor[a.activity_type] ?? "rgba(18,18,18,.5)", textTransform: "uppercase", letterSpacing: 0.5 }}>
                                {typeLabel[a.activity_type] ?? a.activity_type}
                              </span>
                              <span style={{ fontSize: 11, color: "rgba(18,18,18,.35)" }}>
                                {new Date(a.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                              </span>
                            </div>
                            <div style={{ fontSize: 13, lineHeight: 1.45 }}>{a.note}</div>
                          </div>
                          <button onClick={() => deleteActivity(a.id)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: "rgba(18,18,18,.3)", padding: "0 4px", flexShrink: 0 }}>✕</button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="row" style={{ gap: 8 }}>
              {editTab !== "activity" && (
                <button className="btn btnPrimary" onClick={saveDeal} disabled={saving}>
                  {saving ? "Saving…" : "Save"}
                </button>
              )}
              <button className="btn" onClick={() => setMovingDeal(null)}>Close</button>
              <a className="btn" href={`/contacts/${movingDeal.contact_id}`} style={{ textDecoration: "none", marginLeft: "auto" }}>
                Open contact →
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
