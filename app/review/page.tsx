"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import ContactSearchInput from "@/components/ContactSearchInput";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const supabase = createSupabaseBrowserClient();

// ── Types ─────────────────────────────────────────────────────────────────────

type ReviewTab = "unmatched" | "calendar" | "triage";

type UnmatchedRow = {
  id: string;
  email: string;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  last_subject: string | null;
  last_snippet: string | null;
  last_thread_link: string | null;
  status: "new" | "auto_created" | "linked" | "ignored" | string;
  created_contact_id: string | null;
};

type CreateForm = {
  email: string;
  name: string;
  category: string;
  tier: string;
};

type CalendarItem = {
  id: string;
  event_title: string;
  occurred_at: string;
  attendee_emails: string[];
  attendee_names: string[];
};

type TContact = {
  id: string;
  display_name: string;
  email: string | null;
  company: string | null;
  notes: string | null;
  category: string;
  tier: string | null;
};

type Suggestion = {
  id: string;
  category: string;
  tier: string;
  reason: string;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES = ["Agent", "Client", "Developer", "Vendor", "Sphere", "Other"] as const;
const TIERS = ["A", "B", "C", "D"] as const;

const CAT_KEYS: Record<string, typeof CATEGORIES[number]> = {
  "1": "Agent", "2": "Client", "3": "Developer", "4": "Vendor", "5": "Sphere", "6": "Other",
};

// ── Unmatched helpers ─────────────────────────────────────────────────────────

function domainOf(email: string) {
  return (email.split("@")[1] || "").toLowerCase().trim();
}

function isPhone(s: string): boolean {
  return s.startsWith("+") && !s.includes("@");
}

function displayFromEmail(email: string): string {
  if (isPhone(email)) return "";
  const local = email.split("@")[0] || email;
  return local
    .replace(/[._-]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || email;
}

function isConsumerDomain(domain: string) {
  return new Set([
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "icloud.com",
    "me.com", "mac.com", "hotmail.com", "outlook.com", "live.com", "aol.com",
    "proton.me", "protonmail.com",
  ]).has(domain);
}

function classifyUnmatched(email: string, subject?: string | null, snippet?: string | null) {
  const d = domainOf(email);
  const text = `${subject || ""} ${snippet || ""}`.toLowerCase();
  const vendorHints = [
    "escrow", "title", "lender", "mortgage", "loan", "underwriting", "appraisal",
    "appraiser", "inspection", "inspector", "staging", "stager", "contractor",
    "plumber", "electric", "hvac", "roof", "pest", "termite", "photography",
    "photographer", "cleaning", "cleaner", "moving", "mover", "insurance", "warranty",
  ];
  const agentHints = [
    "dre", "realtor", "real estate", "broker", "brokerage", "listing", "offer",
    "open house", "showing", "mls", "compass", "sotheby", "coldwell", "kw", "keller",
    "bhhs", "berkshire", "douglas elliman", "the agency",
  ];
  const vendorScore =
    vendorHints.reduce((acc, k) => acc + (d.includes(k) || text.includes(k) ? 1 : 0), 0) +
    (d.includes("escrow") ? 2 : 0) + (d.includes("title") ? 2 : 0);
  const agentScore =
    agentHints.reduce((acc, k) => acc + (d.includes(k) || text.includes(k) ? 1 : 0), 0) +
    (d.includes("compass") ? 2 : 0);
  let label: "Likely Agent" | "Likely Vendor" | "Likely Client/Lead" | "Unclear" = "Unclear";
  let confidence = 0.5;
  let suggestedCategory = "Agent";
  if (vendorScore >= 2 && vendorScore >= agentScore + 1) {
    label = "Likely Vendor"; confidence = Math.min(0.95, 0.6 + vendorScore * 0.08); suggestedCategory = "Vendor";
  } else if (agentScore >= 2 && agentScore >= vendorScore + 1) {
    label = "Likely Agent"; confidence = Math.min(0.95, 0.6 + agentScore * 0.08); suggestedCategory = "Agent";
  } else if (isConsumerDomain(d)) {
    label = "Likely Client/Lead"; confidence = 0.65; suggestedCategory = "Client";
  }
  return { label, confidence, suggestedCategory };
}

function capitalize(s: string) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

function TabBar({ tabs, active, onChange }: {
  tabs: { id: ReviewTab; label: string; count: number }[];
  active: ReviewTab;
  onChange: (t: ReviewTab) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 2, borderBottom: "2px solid rgba(0,0,0,.1)" }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          style={{
            padding: "8px 16px",
            border: "none",
            background: active === t.id ? "var(--ink)" : "transparent",
            color: active === t.id ? "var(--paper)" : "rgba(18,18,18,.6)",
            borderRadius: "6px 6px 0 0",
            cursor: "pointer",
            fontSize: 14,
            fontWeight: active === t.id ? 800 : 500,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {t.label}
          {t.count > 0 && (
            <span style={{
              background: active === t.id ? "rgba(255,255,255,.25)" : "rgba(18,18,18,.12)",
              borderRadius: 10,
              padding: "1px 7px",
              fontSize: 11,
              fontWeight: 700,
            }}>
              {t.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ReviewPage() {
  const [tab, setTab] = useState<ReviewTab>("unmatched");
  const [uid, setUid] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // ── Unmatched state ──
  const [unmatchedRows, setUnmatchedRows] = useState<UnmatchedRow[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState<CreateForm | null>(null);
  const [unmatchedBusy, setUnmatchedBusy] = useState(false);
  const [unmatchedErr, setUnmatchedErr] = useState<string | null>(null);

  // ── Calendar state ──
  const [calSyncing, setCalSyncing] = useState(false);
  const [calSyncedAt, setCalSyncedAt] = useState<string | null>(null);
  const [calQueue, setCalQueue] = useState<CalendarItem[]>([]);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [linkQuery, setLinkQuery] = useState<Record<string, string>>({});
  const [linkResults, setLinkResults] = useState<Record<string, { id: string; display_name: string }[]>>({});
  const [linkWorking, setLinkWorking] = useState<string | null>(null);
  const [calErr, setCalErr] = useState<string | null>(null);
  const [calMsg, setCalMsg] = useState<string | null>(null);

  // ── Triage state ──
  const [triageContacts, setTriageContacts] = useState<TContact[]>([]);
  const [totalUnclassified, setTotalUnclassified] = useState(0);
  const [triageIdx, setTriageIdx] = useState(0);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const [selectedCat, setSelectedCat] = useState<string>("");
  const [selectedTier, setSelectedTier] = useState<string>("");
  const [classifying, setClassifying] = useState(false);
  const [triageSaving, setTriageSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [archivedCount, setArchivedCount] = useState(0);
  const [triageError, setTriageError] = useState<string | null>(null);
  const classifyBatchRef = useRef<Set<number>>(new Set());

  // ── Init ──────────────────────────────────────────────────────────────────

  async function getUid(): Promise<string | null> {
    if (uid) return uid;
    const { data: sd } = await supabase.auth.getSession();
    const u = sd.session?.user ?? null;
    if (!u) { window.location.href = "/login"; return null; }
    setUid(u.id);
    return u.id;
  }

  useEffect(() => {
    async function init() {
      const activeUid = await getUid();
      if (!activeUid) return;
      await Promise.all([
        loadUnmatched(activeUid),
        loadCalendarQueue(),
        loadTriage(),
      ]);
      setReady(true);
    }
    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Unmatched ─────────────────────────────────────────────────────────────

  async function loadUnmatched(activeUid: string) {
    const res = await fetch(`/api/unmatched/list?uid=${activeUid}`);
    const j = await res.json();
    if (res.ok) setUnmatchedRows((j.rows || []) as UnmatchedRow[]);
  }

  function removeUnmatchedRow(email: string) {
    setUnmatchedRows((prev) => prev.filter((r) => r.email !== email));
  }

  function openCreateForm(row: UnmatchedRow) {
    const rec = classifyUnmatched(row.email, row.last_subject, row.last_snippet);
    setCreateForm({ email: row.email, name: displayFromEmail(row.email), category: rec.suggestedCategory, tier: "B" });
    setSelectedEmail(null);
    setUnmatchedErr(null);
  }

  function openLinkPanel(email: string) {
    setSelectedEmail(email);
    setCreateForm(null);
    setUnmatchedErr(null);
  }

  async function submitCreate() {
    if (!createForm) return;
    const activeUid = await getUid();
    if (!activeUid) return;
    setUnmatchedBusy(true);
    setUnmatchedErr(null);
    const res = await fetch("/api/unmatched/add-contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: activeUid, email: createForm.email, display_name: createForm.name.trim(), category: createForm.category, tier: createForm.tier || null }),
    });
    const j = await res.json();
    setUnmatchedBusy(false);
    if (!res.ok) { setUnmatchedErr(j?.error || "Create failed"); return; }
    const email = createForm.email;
    setCreateForm(null);
    removeUnmatchedRow(email);
  }

  async function ignoreEmail(email: string) {
    const activeUid = await getUid();
    if (!activeUid) return;
    setUnmatchedBusy(true);
    setUnmatchedErr(null);
    const res = await fetch("/api/unmatched/ignore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: activeUid, email }),
    });
    const j = await res.json();
    setUnmatchedBusy(false);
    if (!res.ok) { setUnmatchedErr(j?.error || "Ignore failed"); return; }
    removeUnmatchedRow(email);
  }

  async function linkEmail(email: string, contactId: string) {
    const activeUid = await getUid();
    if (!activeUid) return;
    if (!contactId) { setUnmatchedErr("Pick a contact to link to."); return; }
    setUnmatchedBusy(true);
    setUnmatchedErr(null);
    const res = await fetch("/api/unmatched/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: activeUid, email, contact_id: contactId }),
    });
    const j = await res.json();
    setUnmatchedBusy(false);
    if (!res.ok) { setUnmatchedErr(j?.error || "Link failed"); return; }
    setSelectedEmail(null);
    removeUnmatchedRow(email);
  }

  // ── Calendar ──────────────────────────────────────────────────────────────

  async function loadCalendarQueue() {
    const res = await fetch("/api/calendar/review");
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      setCalQueue(j.items ?? []);
    }
  }

  async function calSearchContacts(itemId: string, q: string) {
    setLinkQuery((prev) => ({ ...prev, [itemId]: q }));
    if (q.trim().length < 2) { setLinkResults((prev) => ({ ...prev, [itemId]: [] })); return; }
    const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(q)}`);
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      setLinkResults((prev) => ({ ...prev, [itemId]: j.results ?? [] }));
    }
  }

  async function linkToContact(itemId: string, contactId: string) {
    setLinkWorking(itemId);
    const res = await fetch("/api/calendar/review", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: itemId, action: "link", contact_id: contactId }),
    });
    setLinkWorking(null);
    if (res.ok) { setCalQueue((prev) => prev.filter((i) => i.id !== itemId)); setLinkingId(null); }
  }

  async function dismissItem(itemId: string) {
    setLinkWorking(itemId);
    await fetch("/api/calendar/review", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: itemId, action: "dismiss" }),
    });
    setLinkWorking(null);
    setCalQueue((prev) => prev.filter((i) => i.id !== itemId));
  }

  async function runCalendarSync() {
    const activeUid = await getUid();
    if (!activeUid) return;
    setCalSyncing(true);
    setCalErr(null);
    setCalMsg(null);
    const res = await fetch("/api/calendar/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: 90 }),
    });
    const j = await res.json().catch(() => ({}));
    setCalSyncing(false);
    if (!res.ok) { setCalErr(j?.error || "Calendar sync failed"); return; }
    setCalSyncedAt(new Date().toISOString());
    setCalMsg(`Sync done — ${j.imported} imported, ${j.unmatched_queued ?? 0} queued for review`);
    await loadCalendarQueue();
  }

  // ── Triage ────────────────────────────────────────────────────────────────

  async function loadTriage() {
    const { data, error: err } = await supabase
      .from("contacts")
      .select("id, display_name, email, company, notes, category, tier")
      .is("tier", null)
      .eq("archived", false)
      .order("display_name", { ascending: true })
      .limit(500);
    if (err) { setTriageError(err.message); return; }
    const rows = (data || []) as TContact[];
    setTriageContacts(rows);
    setTotalUnclassified(rows.length);
    if (rows.length > 0) classifyBatch(rows, 0);
  }

  async function classifyBatch(all: TContact[], startIdx: number) {
    const batchKey = Math.floor(startIdx / 25);
    if (classifyBatchRef.current.has(batchKey)) return;
    classifyBatchRef.current.add(batchKey);
    const batch = all.slice(startIdx, startIdx + 25);
    if (batch.length === 0) return;
    setClassifying(true);
    try {
      const res = await fetch("/api/contacts/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contacts: batch.map((c) => ({ id: c.id, display_name: c.display_name, email: c.email, company: c.company, notes: c.notes ? c.notes.slice(0, 400) : null, category: c.category })),
        }),
      });
      const j = await res.json();
      if (res.ok && Array.isArray(j.suggestions)) {
        setSuggestions((prev) => {
          const next = { ...prev };
          for (const s of j.suggestions as Suggestion[]) next[s.id] = s;
          return next;
        });
      }
    } catch { /* non-fatal */ }
    finally { setClassifying(false); }
  }

  useEffect(() => {
    if (triageContacts.length === 0) return;
    const nextBatchStart = Math.floor((triageIdx + 10) / 25) * 25;
    if (nextBatchStart < triageContacts.length) classifyBatch(triageContacts, nextBatchStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triageIdx, triageContacts]);

  const triageCurrent = triageContacts[triageIdx] ?? null;
  useEffect(() => {
    if (!triageCurrent) return;
    const sug = suggestions[triageCurrent.id];
    if (sug) { setSelectedCat(sug.category); setSelectedTier(sug.tier); }
    else { setSelectedCat(triageCurrent.category !== "other" ? capitalize(triageCurrent.category) : ""); setSelectedTier(""); }
  }, [triageCurrent?.id, suggestions]);

  async function triageSaveAndAdvance(cat: string, tier: string) {
    if (!triageCurrent || triageSaving) return;
    setTriageSaving(true);
    setTriageError(null);
    const { error: err } = await supabase.from("contacts").update({ category: cat, tier }).eq("id", triageCurrent.id);
    setTriageSaving(false);
    if (err) { setTriageError(`Save failed: ${err.message}`); return; }
    setSavedCount((n) => n + 1);
    triageAdvance();
  }

  async function triageArchiveAndAdvance() {
    if (!triageCurrent || triageSaving) return;
    setTriageSaving(true);
    setTriageError(null);
    const { error: err } = await supabase.from("contacts").update({ archived: true }).eq("id", triageCurrent.id);
    setTriageSaving(false);
    if (err) { setTriageError(`Archive failed: ${err.message}`); return; }
    setArchivedCount((n) => n + 1);
    triageAdvance();
  }

  function triageSkip() { setSkippedCount((n) => n + 1); triageAdvance(); }
  function triageAdvance() { setSelectedCat(""); setSelectedTier(""); setTriageIdx((i) => i + 1); }

  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (tab !== "triage" || !triageCurrent || triageSaving) return;
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const cat = CAT_KEYS[e.key];
      if (cat) { setSelectedCat(cat); return; }
      if (e.key === "a" || e.key === "A") { triageSaveAndAdvance(selectedCat || "Other", "A"); return; }
      if (e.key === "b" || e.key === "B") { triageSaveAndAdvance(selectedCat || "Other", "B"); return; }
      if (e.key === "c" || e.key === "C") { triageSaveAndAdvance(selectedCat || "Other", "C"); return; }
      if (e.key === "d" || e.key === "D") { triageSaveAndAdvance(selectedCat || "Other", "D"); return; }
      if (e.key === "x" || e.key === "X") { triageArchiveAndAdvance(); return; }
      if (e.key === "s" || e.key === " ") { e.preventDefault(); triageSkip(); return; }
    },
    [tab, triageCurrent, triageSaving, selectedCat]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (!ready) return <div className="card cardPad">Loading…</div>;

  const triageDone = triageIdx >= triageContacts.length;
  const triageProgress = totalUnclassified > 0
    ? Math.round(((savedCount + skippedCount) / totalUnclassified) * 100)
    : 100;
  const triageSug = triageCurrent ? suggestions[triageCurrent.id] : null;
  const triageRemaining = Math.max(0, totalUnclassified - savedCount - skippedCount - archivedCount);

  const tabs = [
    { id: "unmatched" as ReviewTab, label: "Unmatched", count: unmatchedRows.length },
    { id: "calendar" as ReviewTab, label: "Calendar", count: calQueue.length },
    { id: "triage" as ReviewTab, label: "Triage", count: triageRemaining },
  ];

  return (
    <div className="stack">
      <h1 className="h1">Review</h1>

      <TabBar tabs={tabs} active={tab} onChange={setTab} />

      {/* ── Unmatched tab ────────────────────────────────────────────────── */}
      {tab === "unmatched" && (
        <div className="stack">
          <div className="rowBetween">
            <div className="subtle">
              Review sent emails not yet tied to your CRM. <strong>{unmatchedRows.length}</strong> items.
            </div>
            <button
              className="btn"
              onClick={() => getUid().then((id) => { if (id) loadUnmatched(id); })}
              disabled={unmatchedBusy}
            >
              Refresh
            </button>
          </div>

          {unmatchedErr && <div className="alert alertError">{unmatchedErr}</div>}

          <div className="stack">
            {unmatchedRows.map((r) => {
              const rec = classifyUnmatched(r.email, r.last_subject, r.last_snippet);
              const isLinking = selectedEmail === r.email;
              const isCreating = createForm?.email === r.email;
              return (
                <div key={r.id} className="card cardPad stack">
                  <div className="rowBetween" style={{ alignItems: "flex-start" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 900, fontSize: 16, wordBreak: "break-word" }}>{r.email}</div>
                      <div className="row" style={{ marginTop: 10 }}>
                        <span className="badge">Seen {r.seen_count}</span>
                        <span className="badge">Last {new Date(r.last_seen_at).toLocaleString()}</span>
                        {!isPhone(r.email) && (
                          <span className="badge">{rec.label} ({Math.round(rec.confidence * 100)}%)</span>
                        )}
                      </div>
                      {r.last_subject && (
                        <div style={{ marginTop: 10 }}>
                          <div className="label">Subject</div>
                          <div style={{ fontWeight: 800 }}>{r.last_subject}</div>
                        </div>
                      )}
                      {r.last_snippet && (
                        <div style={{ marginTop: 6 }}>
                          <div className="subtle" style={{ color: "rgba(18,18,18,.78)" }}>{r.last_snippet}</div>
                        </div>
                      )}
                      {r.last_thread_link && (
                        <div style={{ marginTop: 6 }}>
                          <a href={r.last_thread_link} target="_blank" rel="noreferrer">Open Gmail thread</a>
                        </div>
                      )}
                    </div>
                    <div className="stack" style={{ minWidth: 180, flexShrink: 0 }}>
                      <button
                        className={`btn ${isLinking ? "" : "btnPrimary"}`}
                        onClick={() => isLinking ? setSelectedEmail(null) : openLinkPanel(r.email)}
                        disabled={unmatchedBusy}
                      >
                        {isLinking ? "Cancel link" : "Link to contact"}
                      </button>
                      <button
                        className="btn"
                        onClick={() => isCreating ? setCreateForm(null) : openCreateForm(r)}
                        disabled={unmatchedBusy}
                      >
                        {isCreating ? "Cancel create" : "Create contact"}
                      </button>
                      <button className="btn btnGhost" onClick={() => ignoreEmail(r.email)} disabled={unmatchedBusy}>
                        Ignore
                      </button>
                    </div>
                  </div>

                  {isLinking && (
                    <div className="stack" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(0,0,0,0.08)" }}>
                      <div style={{ fontWeight: 800, fontSize: 14 }}>Link to contact</div>
                      <ContactSearchInput
                        selectedId=""
                        selectedName=""
                        onSelect={(id) => linkEmail(r.email, id)}
                        placeholder="Search or create a contact…"
                        autoFocus
                      />
                    </div>
                  )}

                  {isCreating && createForm && (
                    <div className="stack" style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(0,0,0,0.08)" }}>
                      <div style={{ fontWeight: 800, fontSize: 14 }}>Create new contact</div>
                      <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: 10 }}>
                        <div className="field" style={{ flex: 1, minWidth: 200 }}>
                          <div className="label">Name</div>
                          <input
                            className="input"
                            value={createForm.name}
                            onChange={(e) => setCreateForm((f) => f ? { ...f, name: e.target.value } : f)}
                            placeholder="Full name"
                            autoFocus
                          />
                        </div>
                        <div className="field" style={{ minWidth: 150 }}>
                          <div className="label">Category</div>
                          <select className="select" value={createForm.category} onChange={(e) => setCreateForm((f) => f ? { ...f, category: e.target.value } : f)}>
                            <option>Agent</option>
                            <option>Client</option>
                            <option>Developer</option>
                            <option>Vendor</option>
                            <option>Sphere</option>
                            <option>Other</option>
                          </select>
                        </div>
                        <div className="field" style={{ minWidth: 90 }}>
                          <div className="label">Tier</div>
                          <select className="select" value={createForm.tier} onChange={(e) => setCreateForm((f) => f ? { ...f, tier: e.target.value } : f)}>
                            <option value="A">A</option>
                            <option value="B">B</option>
                            <option value="C">C</option>
                            <option value="D">D</option>
                          </select>
                        </div>
                        <button
                          className="btn btnPrimary"
                          onClick={submitCreate}
                          disabled={unmatchedBusy || !createForm.name.trim()}
                        >
                          {unmatchedBusy ? "Creating…" : "Create"}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {unmatchedRows.length === 0 && (
              <div className="card cardPad">
                <div className="subtle">Nothing to review — inbox is clean.</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Calendar tab ─────────────────────────────────────────────────── */}
      {tab === "calendar" && (
        <div className="stack">
          <div className="rowBetween">
            <div className="subtle">
              Link calendar attendees to CRM contacts to log those meetings as touches.
            </div>
            <button className="btn" onClick={runCalendarSync} disabled={calSyncing}>
              {calSyncing ? "Syncing…" : calSyncedAt ? "Re-sync calendar" : "Sync calendar (90 days)"}
            </button>
          </div>

          {calSyncedAt && (
            <div className="muted small">
              Last synced {new Date(calSyncedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </div>
          )}

          {calErr && <div className="alert alertError">{calErr}</div>}
          {calMsg && (
            <div style={{ padding: "10px 14px", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, fontSize: 14, color: "#15803d", fontWeight: 600 }}>
              {calMsg}
            </div>
          )}

          {calQueue.length === 0 ? (
            <div className="card cardPad">
              <div className="subtle">No unmatched meetings — all clear.</div>
            </div>
          ) : (
            <div className="card cardPad">
              <div style={{ fontWeight: 900, marginBottom: 4 }}>
                Unmatched meetings — {calQueue.length} need review
              </div>
              <div className="muted small" style={{ marginBottom: 14 }}>
                These calendar events had attendees but no email match in your CRM. Link each to a contact to log the touch, or dismiss.
              </div>
              <div className="stack" style={{ gap: 0 }}>
                {calQueue.map((item, i) => {
                  const isLinking = linkingId === item.id;
                  const working = linkWorking === item.id;
                  const date = new Date(item.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
                  const attendees = item.attendee_names.length > 0 ? item.attendee_names : item.attendee_emails;
                  return (
                    <div key={item.id} style={{ padding: "12px 0", borderBottom: i < calQueue.length - 1 ? "1px solid rgba(0,0,0,.06)" : undefined }}>
                      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap" }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>{item.event_title}</div>
                          <div className="muted small" style={{ marginTop: 2 }}>
                            {date} · {attendees.slice(0, 3).join(", ")}{attendees.length > 3 ? ` +${attendees.length - 3} more` : ""}
                          </div>
                        </div>
                        <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                          <button
                            className="btn btnPrimary"
                            style={{ fontSize: 12 }}
                            disabled={working}
                            onClick={() => setLinkingId(isLinking ? null : item.id)}
                          >
                            {isLinking ? "Cancel" : "Link contact"}
                          </button>
                          <button
                            className="btn"
                            style={{ fontSize: 12 }}
                            disabled={working}
                            onClick={() => dismissItem(item.id)}
                          >
                            {working ? "…" : "Dismiss"}
                          </button>
                        </div>
                      </div>
                      {isLinking && (
                        <div style={{ marginTop: 10 }}>
                          <input
                            className="input"
                            placeholder="Search contacts…"
                            value={linkQuery[item.id] ?? ""}
                            onChange={(e) => calSearchContacts(item.id, e.target.value)}
                            style={{ marginBottom: 6 }}
                            autoFocus
                          />
                          {(linkResults[item.id] ?? []).map((c) => (
                            <div
                              key={c.id}
                              style={{ padding: "8px 10px", cursor: "pointer", borderRadius: 6, fontSize: 13, fontWeight: 600, background: "rgba(0,0,0,.03)", marginBottom: 4 }}
                              onClick={() => linkToContact(item.id, c.id)}
                            >
                              {c.display_name}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Triage tab ───────────────────────────────────────────────────── */}
      {tab === "triage" && (
        <div>
          <div style={{ marginBottom: 20 }}>
            <div className="rowBetween" style={{ marginBottom: 6 }}>
              <span className="muted small">
                {savedCount} classified · {archivedCount > 0 ? `${archivedCount} archived · ` : ""}{skippedCount} skipped · {triageRemaining} remaining
              </span>
              <span className="muted small">{triageProgress}%</span>
            </div>
            <div style={{ height: 6, background: "rgba(0,0,0,0.08)", borderRadius: 3, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${triageProgress}%`, background: "#121212", borderRadius: 3, transition: "width 0.3s" }} />
            </div>
          </div>

          {triageError && <div className="alert alertError" style={{ marginBottom: 12 }}>{triageError}</div>}

          {triageDone ? (
            <div className="card cardPad" style={{ textAlign: "center", padding: "48px 24px" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
              <div style={{ fontWeight: 900, fontSize: 20, marginBottom: 8 }}>All done!</div>
              <div className="muted" style={{ marginBottom: 20 }}>
                {savedCount} contacts classified · {skippedCount} skipped
              </div>
              <div className="row" style={{ justifyContent: "center", gap: 8 }}>
                <a className="btn btnPrimary" href="/morning">Go to Morning →</a>
                <a className="btn" href="/contacts">View Contacts</a>
              </div>
            </div>
          ) : (
            <>
              <div className="card cardPad" style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                  <div>
                    <div style={{ fontWeight: 900, fontSize: 22 }}>{triageCurrent?.display_name}</div>
                    {(triageCurrent?.email || triageCurrent?.company) && (
                      <div className="muted" style={{ marginTop: 4, fontSize: 14 }}>
                        {[triageCurrent.email, triageCurrent.company].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </div>
                  <div className="muted small" style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
                    {triageIdx + 1} / {triageContacts.length}
                  </div>
                </div>

                {triageSug && (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ padding: "10px 14px", background: "rgba(0,0,0,0.04)", borderRadius: 8, fontSize: 13, marginBottom: 8 }}>
                      <span style={{ fontWeight: 700 }}>AI suggests:</span>{" "}
                      {triageSug.category} · Tier {triageSug.tier}
                      {triageSug.reason && <span className="muted"> — {triageSug.reason}</span>}
                    </div>
                    <button
                      className="btn btnPrimary"
                      style={{ width: "100%", justifyContent: "center", fontSize: 15, padding: "11px", marginBottom: 4 }}
                      onClick={() => triageSaveAndAdvance(triageSug.category, triageSug.tier)}
                      disabled={triageSaving}
                    >
                      {triageSaving ? "Saving…" : `✓ Accept — ${triageSug.category} · Tier ${triageSug.tier}`}
                    </button>
                    <div className="muted small" style={{ textAlign: "center" }}>or pick a different category/tier below</div>
                  </div>
                )}
                {classifying && !triageSug && (
                  <div className="muted small" style={{ marginBottom: 12 }}>Classifying…</div>
                )}

                {triageCurrent?.notes && (
                  <div className="muted small" style={{ fontSize: 12, maxHeight: 60, overflow: "hidden", marginBottom: 12, lineHeight: 1.5 }}>
                    {triageCurrent.notes.slice(0, 200)}{triageCurrent.notes.length > 200 ? "…" : ""}
                  </div>
                )}

                <div style={{ marginBottom: 10 }}>
                  <div className="label" style={{ marginBottom: 6 }}>Category <span className="muted small">(keys 1–6)</span></div>
                  <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                    {CATEGORIES.map((cat, i) => (
                      <button
                        key={cat}
                        className={`btn${selectedCat === cat ? " btnPrimary" : ""}`}
                        style={{ fontSize: 13, minWidth: 80 }}
                        onClick={() => setSelectedCat(cat)}
                      >
                        <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>{i + 1}</span>{cat}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ marginBottom: 16 }}>
                  <div className="label" style={{ marginBottom: 6 }}>
                    Tier — click to save &amp; next <span className="muted small">(keys A / B / C / D)</span>
                  </div>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    {TIERS.map((tier) => (
                      <button
                        key={tier}
                        className={`btn${selectedTier === tier ? " btnPrimary" : ""}`}
                        style={{ fontSize: 15, fontWeight: 800, minWidth: 64, padding: "8px 20px" }}
                        onClick={() => triageSaveAndAdvance(selectedCat || "Other", tier)}
                        disabled={triageSaving}
                      >
                        {tier}
                      </button>
                    ))}
                    <button
                      className="btn"
                      style={{ fontSize: 13, color: "#8a0000", borderColor: "rgba(200,0,0,.2)" }}
                      onClick={triageArchiveAndAdvance}
                      disabled={triageSaving}
                      title="Archive — removes from outreach queue (X)"
                    >
                      Archive (X)
                    </button>
                    <button className="btn" style={{ fontSize: 13 }} onClick={triageSkip} disabled={triageSaving}>
                      Skip (S)
                    </button>
                  </div>
                </div>

                <div className="muted small">
                  Tier A = monthly · B = 60 days · C = 90 days · D = 4–6 months · Archive = remove from outreach queue
                </div>
              </div>

              {triageContacts.slice(triageIdx + 1, triageIdx + 4).length > 0 && (
                <div className="muted small" style={{ paddingLeft: 4 }}>
                  Up next: {triageContacts.slice(triageIdx + 1, triageIdx + 4).map((c) => c.display_name).join(" · ")}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
