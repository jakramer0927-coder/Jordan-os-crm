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
  phone: string | null;
  company: string | null;
  notes: string | null;
  client_type: string | null;
};

type LastTouch = {
  occurred_at: string;
  channel: string;
  summary: string | null;
  days: number;
};

function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

function cadenceDays(category: string, tier: string | null): number {
  const cat = (category || "").toLowerCase();
  const t = (tier || "").toUpperCase();
  if (cat === "client") return t === "A" ? 30 : t === "B" ? 60 : 90;
  if (cat === "sphere") return t === "A" ? 60 : t === "B" ? 90 : 120;
  if (cat === "agent") return t === "A" ? 30 : 60;
  return 60;
}

function channelLabel(c: string) {
  switch (c) {
    case "text": return "Text";
    case "email": return "Email";
    case "call": return "Call";
    case "in_person": return "In person";
    case "social_dm": return "Social DM";
    default: return c;
  }
}

export default function ContactsPage() {
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ContactLite[]>([]);
  const [lastTouchMap, setLastTouchMap] = useState<Map<string, LastTouch>>(new Map());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // expanded row + inline log
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [logChannel, setLogChannel] = useState("text");
  const [logSummary, setLogSummary] = useState("");
  const [logSaving, setLogSaving] = useState(false);
  const [logMsg, setLogMsg] = useState<string | null>(null);

  // triage mode
  const [triageMode, setTriageMode] = useState(false);
  const [triageFilter, setTriageFilter] = useState<"all" | "never" | "notier" | "other">("never");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
    if (!user) { window.location.href = "/login"; return null; }
    setUid(user.id);
    return user;
  }

  async function loadTouches(contactIds: string[]) {
    if (contactIds.length === 0) return;
    const { data } = await supabase
      .from("touches")
      .select("contact_id, occurred_at, channel, summary")
      .eq("direction", "outbound")
      .in("contact_id", contactIds)
      .order("occurred_at", { ascending: false })
      .limit(1000);

    const map = new Map<string, LastTouch>();
    for (const t of (data ?? []) as any[]) {
      if (!map.has(t.contact_id)) {
        map.set(t.contact_id, {
          occurred_at: t.occurred_at,
          channel: t.channel,
          summary: t.summary,
          days: daysSince(t.occurred_at),
        });
      }
    }
    setLastTouchMap(map);
  }

  async function loadRecent() {
    setBusy(true);
    setErr(null);

    const { data, error } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, email, phone, company, notes, client_type")
      .eq("archived", false)
      .order("display_name", { ascending: true })
      .limit(500);

    setBusy(false);

    if (error) { setErr(`Load failed: ${error.message}`); setRows([]); return; }

    const contacts = (data ?? []) as ContactLite[];
    setRows(contacts);
    await loadTouches(contacts.map((c) => c.id));
  }

  async function search(term: string) {
    if (!uid) return;
    const qRaw = term.trim();
    if (!qRaw) { await loadRecent(); return; }
    if (qRaw.length < 2) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setErr(null);

    try {
      const res = await fetch(`/api/contacts/search?uid=${uid}&q=${encodeURIComponent(qRaw)}`, { signal: ac.signal });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(j?.error || "Search failed"); setRows([]); return; }
      const results = (j.results || []) as ContactLite[];
      setRows(results);
      await loadTouches(results.map((c) => c.id));
    } catch (e: any) {
      if (e?.name !== "AbortError") setErr(e?.message || "Search failed");
    } finally {
      setBusy(false);
    }
  }

  async function quickLog(contactId: string) {
    setLogSaving(true);
    setLogMsg(null);
    const { error } = await supabase.from("touches").insert({
      contact_id: contactId,
      channel: logChannel,
      direction: "outbound",
      intent: "check_in",
      occurred_at: new Date().toISOString(),
      summary: logSummary.trim() || null,
      source: "manual",
    });
    setLogSaving(false);
    if (error) { setLogMsg(`Error: ${error.message}`); return; }
    setLogSummary("");
    setLogMsg("Logged ✓");
    // refresh touch map for this contact
    const now = new Date().toISOString();
    setLastTouchMap((prev) => {
      const next = new Map(prev);
      next.set(contactId, { occurred_at: now, channel: logChannel, summary: logSummary.trim() || null, days: 0 });
      return next;
    });
    setTimeout(() => setLogMsg(null), 2000);
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
    if (error) { setAddErr(error.message); return; }

    setAddName(""); setAddCategory("Client"); setAddTier("B");
    setAddClientType(""); setAddCompany(""); setAddEmail("");
    setAddOpen(false);
    loadRecent();
  }

  function toggleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      setLogSummary("");
      setLogMsg(null);
    } else {
      setExpandedId(id);
      setLogChannel("text");
      setLogSummary("");
      setLogMsg(null);
    }
  }

  async function bulkAction(action: "archive" | "delete") {
    if (!uid || selectedIds.size === 0) return;
    setBulkBusy(true);
    setBulkMsg(null);
    const res = await fetch("/api/contacts/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, action, ids: Array.from(selectedIds) }),
    });
    const j = await res.json().catch(() => ({}));
    setBulkBusy(false);
    setConfirmDelete(false);
    if (!res.ok) { setBulkMsg(`Error: ${j?.error || "Failed"}`); return; }
    setBulkMsg(`${action === "archive" ? "Archived" : "Deleted"} ${j.affected} contact${j.affected !== 1 ? "s" : ""}`);
    setSelectedIds(new Set());
    await loadRecent();
    setTimeout(() => setBulkMsg(null), 3000);
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleSelectAll(ids: string[]) {
    const allSelected = ids.every((id) => selectedIds.has(id));
    setSelectedIds(allSelected ? new Set() : new Set(ids));
  }

  useEffect(() => {
    requireSession().then((u) => {
      if (!u) return;
      setReady(true);
      loadRecent();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!uid) return;
    const t = setTimeout(() => search(q), 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, uid]);

  const triageRows = useMemo(() => {
    let filtered = [...rows];
    if (triageFilter === "never") filtered = filtered.filter((c) => !lastTouchMap.has(c.id));
    else if (triageFilter === "notier") filtered = filtered.filter((c) => !c.tier);
    else if (triageFilter === "other") filtered = filtered.filter((c) => (c.category || "").toLowerCase() === "other");
    // Sort: never contacted first, then by oldest touch
    filtered.sort((a, b) => {
      const la = lastTouchMap.get(a.id);
      const lb = lastTouchMap.get(b.id);
      if (!la && !lb) return a.display_name.localeCompare(b.display_name);
      if (!la) return -1;
      if (!lb) return 1;
      return lb.days - la.days; // oldest first
    });
    return filtered;
  }, [rows, lastTouchMap, triageFilter]);

  const hint = useMemo(() => {
    const qt = q.trim();
    if (!qt) return busy ? "Loading…" : `${rows.length} contacts`;
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
          <div className="muted" style={{ marginTop: 6 }}>
            <span className="badge">{hint}</span>
          </div>
        </div>
        <div className="row">
          <a className="btn" href="/morning">Morning</a>
          <a className="btn" href="/unmatched">Unmatched</a>
          <a className="btn" href="/contacts/import">Import CSV</a>
          <a className="btn" href="/linkedin">LinkedIn</a>
          <button
            className="btn"
            style={triageMode ? { background: "#fef3c7", borderColor: "#fcd34d", fontWeight: 700 } : {}}
            onClick={() => { setTriageMode((v) => !v); setSelectedIds(new Set()); setBulkMsg(null); setConfirmDelete(false); }}
          >
            {triageMode ? "Exit triage" : "Triage"}
          </button>
          <button className="btn btnPrimary" onClick={() => { setAddOpen((v) => !v); setAddErr(null); }}>
            {addOpen ? "Cancel" : "Add contact"}
          </button>
        </div>
      </div>

      {err ? <div className="alert alertError">{err}</div> : null}

      {addOpen && (
        <div className="card cardPad stack" style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 900 }}>New contact</div>
          {addErr && <div className="alert alertError">{addErr}</div>}
          <div className="fieldGridMobile" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ flex: 2, minWidth: 220 }}>
              <div className="label">Name *</div>
              <input className="input" value={addName} onChange={(e) => setAddName(e.target.value)}
                placeholder="Full name" autoFocus onKeyDown={(e) => e.key === "Enter" && addContact()} />
            </div>
            <div className="field" style={{ width: 160 }}>
              <div className="label">Category</div>
              <select className="select" value={addCategory} onChange={(e) => setAddCategory(e.target.value)}>
                <option>Client</option><option>Sphere</option><option>Agent</option>
                <option>Developer</option><option>Vendor</option><option>Other</option>
              </select>
            </div>
            <div className="field" style={{ width: 100 }}>
              <div className="label">Tier</div>
              <select className="select" value={addTier} onChange={(e) => setAddTier(e.target.value as any)}>
                <option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option>
              </select>
            </div>
          </div>
          <div className="fieldGridMobile" style={{ alignItems: "flex-end" }}>
            <div className="field" style={{ flex: 1, minWidth: 180 }}>
              <div className="label">Company</div>
              <input className="input" value={addCompany} onChange={(e) => setAddCompany(e.target.value)} placeholder="Compass, etc." />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <div className="label">Email</div>
              <input className="input" type="email" value={addEmail} onChange={(e) => setAddEmail(e.target.value)} placeholder="email@example.com" />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 180 }}>
              <div className="label">Client type</div>
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

      <div className="card cardPad" style={{ marginBottom: 10 }}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name, email, company…" autoFocus={!addOpen} />
      </div>

      <div className="stack">
        {triageMode && (
        <div className="card cardPad" style={{ background: "#fffbeb", borderColor: "#fcd34d" }}>
          <div className="row" style={{ flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Triage</div>
            {(["never", "notier", "other", "all"] as const).map((f) => (
              <button
                key={f}
                className="btn"
                style={triageFilter === f ? { fontWeight: 700, background: "#1e293b", color: "#fff", borderColor: "#1e293b" } : { fontSize: 12 }}
                onClick={() => { setTriageFilter(f); setSelectedIds(new Set()); }}
              >
                {{ never: "Never contacted", notier: "No tier set", other: "Category: Other", all: "All contacts" }[f]}
              </button>
            ))}
            <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
              {triageRows.length} shown · {selectedIds.size} selected
            </span>
          </div>

          {selectedIds.size > 0 && (
            <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
              {!confirmDelete ? (
                <>
                  <button className="btn" style={{ fontSize: 13 }} onClick={() => bulkAction("archive")} disabled={bulkBusy}>
                    {bulkBusy ? "Working…" : `Archive ${selectedIds.size}`}
                  </button>
                  <button className="btn" style={{ fontSize: 13, color: "#b91c1c", borderColor: "#fca5a5" }} onClick={() => setConfirmDelete(true)} disabled={bulkBusy}>
                    Delete {selectedIds.size}…
                  </button>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#b91c1c" }}>
                    Permanently delete {selectedIds.size} contact{selectedIds.size !== 1 ? "s" : ""}? This cannot be undone.
                  </span>
                  <button className="btn" style={{ fontSize: 13, background: "#b91c1c", color: "#fff", borderColor: "#b91c1c" }} onClick={() => bulkAction("delete")} disabled={bulkBusy}>
                    {bulkBusy ? "Deleting…" : "Yes, delete"}
                  </button>
                  <button className="btn" style={{ fontSize: 13 }} onClick={() => setConfirmDelete(false)} disabled={bulkBusy}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          )}

          {bulkMsg && (
            <div style={{ marginTop: 8, fontSize: 13, fontWeight: 700, color: bulkMsg.startsWith("Error") ? "#b91c1c" : "#15803d" }}>
              {bulkMsg}
            </div>
          )}
        </div>
      )}

      {triageMode && triageRows.length === 0 && (
        <div className="muted">No contacts match this filter.</div>
      )}

      {triageMode && triageRows.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 2px" }}>
          <input
            type="checkbox"
            checked={triageRows.every((c) => selectedIds.has(c.id))}
            onChange={() => toggleSelectAll(triageRows.map((c) => c.id))}
            style={{ width: 16, height: 16, cursor: "pointer" }}
          />
          <span className="muted" style={{ fontSize: 12 }}>Select all {triageRows.length}</span>
        </div>
      )}

      {(triageMode ? triageRows : rows).map((c) => {
          const last = lastTouchMap.get(c.id) ?? null;
          const cadence = cadenceDays(c.category, c.tier);
          const overdue = last == null || last.days >= cadence;
          const expanded = expandedId === c.id;

          return (
            <div key={c.id} className="card cardPad" style={{ cursor: "default", overflow: "hidden", outline: triageMode && selectedIds.has(c.id) ? "2px solid #f59e0b" : "none" }}>
              {/* Main row */}
              <div
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, cursor: triageMode ? "default" : "pointer" }}
                onClick={() => !triageMode && toggleExpand(c.id)}
              >
                {triageMode && (
                  <input
                    type="checkbox"
                    checked={selectedIds.has(c.id)}
                    onChange={() => toggleSelect(c.id)}
                    onClick={(e) => e.stopPropagation()}
                    style={{ width: 16, height: 16, cursor: "pointer", flexShrink: 0 }}
                  />
                )}
                {/* Days counter */}
                <div style={{ textAlign: "center", minWidth: 52, flexShrink: 0 }}>
                  <div style={{ fontSize: 22, fontWeight: 900, lineHeight: 1, color: overdue ? "#b91c1c" : "#15803d" }}>
                    {last == null ? "∞" : last.days}
                  </div>
                  <div style={{ fontSize: 10, color: "#aaa", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em" }}>
                    {last == null ? "never" : "days"}
                  </div>
                </div>

                {/* Identity + meta */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 900, fontSize: 15 }}>{c.display_name}</div>
                  <div className="row" style={{ marginTop: 4, flexWrap: "wrap", gap: 4 }}>
                    <span className="badge" style={{ fontSize: 11 }}>
                      {c.category}{c.tier ? ` · ${c.tier}` : ""}
                    </span>
                    {c.company && <span className="badge" style={{ fontSize: 11 }}>{c.company}</span>}
                    {c.client_type && <span className="badge" style={{ fontSize: 11 }}>{c.client_type}</span>}
                  </div>
                  {last?.summary && (
                    <div style={{ marginTop: 5, fontSize: 12, color: "#666", lineHeight: 1.4,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                      <span style={{ color: "#aaa", marginRight: 4 }}>Last note:</span>{last.summary}
                    </div>
                  )}
                </div>

                {/* Overdue chip + action */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <span className="badge" style={{ fontSize: 11, color: overdue ? "#b91c1c" : "#15803d", borderColor: overdue ? "#fca5a5" : "#86efac" }}>
                    {overdue ? "Overdue" : "On track"}
                  </span>
                  {triageMode ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      <a className="btn" href={`/contacts/${c.id}`} style={{ fontSize: 11, padding: "2px 8px", textDecoration: "none" }} onClick={(e) => e.stopPropagation()}>View</a>
                      <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} disabled={bulkBusy}
                        onClick={(e) => { e.stopPropagation(); setSelectedIds(new Set([c.id])); bulkAction("archive"); }}>
                        Archive
                      </button>
                    </div>
                  ) : (
                    <span style={{ color: "#aaa", fontSize: 12, userSelect: "none" }}>{expanded ? "▲" : "▼"}</span>
                  )}
                </div>
              </div>

              {/* Expanded panel */}
              {expanded && !triageMode && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(0,0,0,0.07)" }}>
                  {/* Contact info */}
                  {(c.email || c.phone || last) && (
                    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 10, fontSize: 13, color: "#555" }}>
                      {c.email && <a href={`mailto:${c.email}`} style={{ textDecoration: "underline", textUnderlineOffset: 2, color: "#333" }}>{c.email}</a>}
                      {c.phone && <a href={`tel:${c.phone}`} style={{ textDecoration: "underline", textUnderlineOffset: 2, color: "#333" }}>{c.phone}</a>}
                      {last && (
                        <span style={{ color: "#888" }}>
                          Last outreach: {channelLabel(last.channel)} · {new Date(last.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                        </span>
                      )}
                    </div>
                  )}

                  {c.notes && (
                    <div style={{ fontSize: 13, color: "#444", lineHeight: 1.55, whiteSpace: "pre-wrap", background: "rgba(0,0,0,0.03)", borderRadius: 6, padding: "8px 10px", marginBottom: 10 }}>
                      {c.notes}
                    </div>
                  )}

                  {/* Quick log */}
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <select className="select" value={logChannel} onChange={(e) => setLogChannel(e.target.value)}
                      style={{ width: 110, flexShrink: 0, fontSize: 13 }}>
                      <option value="text">Text</option>
                      <option value="email">Email</option>
                      <option value="call">Call</option>
                      <option value="in_person">In person</option>
                      <option value="social_dm">Social DM</option>
                      <option value="other">Other</option>
                    </select>
                    <input
                      className="input"
                      value={logSummary}
                      onChange={(e) => setLogSummary(e.target.value)}
                      placeholder="Note (optional)"
                      style={{ flex: "1 1 120px", minWidth: 0, fontSize: 13 }}
                      onKeyDown={(e) => e.key === "Enter" && quickLog(c.id)}
                    />
                    <button className="btn btnPrimary" style={{ fontSize: 13, flexShrink: 0 }}
                      onClick={() => quickLog(c.id)} disabled={logSaving}>
                      {logSaving ? "Saving…" : "Reached out"}
                    </button>
                    <a className="btn" href={`/contacts/${c.id}`}
                      style={{ textDecoration: "none", fontSize: 13, flexShrink: 0 }}>
                      Full page →
                    </a>
                  </div>
                  {logMsg && (
                    <div style={{ marginTop: 6, fontSize: 13, fontWeight: 700, color: logMsg.startsWith("Error") ? "#b91c1c" : "#15803d" }}>
                      {logMsg}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {!busy && rows.length === 0 && <div className="muted">No matches.</div>}
      </div>
    </div>
  );
}
