"use client";

import { useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const supabase = createSupabaseBrowserClient();

// ── Types ─────────────────────────────────────────────────────────────────────

type SettingsTab = "integrations" | "linkedin";

type LinkedInRow = {
  first_name: string;
  last_name: string;
  email: string;
  company: string;
  position: string;
  connected_on: string;
};

type MatchResult = {
  contact_id: string;
  display_name: string;
  linkedin_name: string;
  match_type: "email" | "name";
  connected_on: string | null;
  company: string;
  position: string;
};

type UnmatchedContact = {
  linkedin_name: string;
  email: string;
  company: string;
  position: string;
  connected_on: string | null;
};

type PreviewResult = {
  total: number;
  matched: number;
  unmatched: number;
  matchedContacts: MatchResult[];
  unmatchedContacts: UnmatchedContact[];
};

type AppliedResult = {
  tagged: number;
  created: number;
};

type CoachingResult = {
  style_summary: string;
  strengths: string[];
  improvements: { issue: string; recommendation: string; example?: string }[];
  style_guide: string;
  score: { warmth: number; clarity: number; brevity: number; relevance: number; overall: number };
};

// ── LinkedIn CSV helpers ──────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseLinkedInCSV(text: string): LinkedInRow[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const headerIdx = lines.findIndex((l) => /first.?name/i.test(l));
  if (headerIdx === -1) return [];
  const headers = parseCSVLine(lines[headerIdx]).map((h) => h.toLowerCase().replace(/[^a-z]/g, ""));
  const get = (cols: string[], keyword: string) => {
    const idx = headers.findIndex((h) => h.includes(keyword));
    return idx >= 0 ? (cols[idx] ?? "").replace(/^"|"$/g, "").trim() : "";
  };
  const rows: LinkedInRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 2) continue;
    const first = get(cols, "first");
    const last = get(cols, "last");
    if (!first && !last) continue;
    rows.push({ first_name: first, last_name: last, email: get(cols, "email"), company: get(cols, "company"), position: get(cols, "position"), connected_on: get(cols, "connected") });
  }
  return rows;
}

function buildApplyLabel(matched: number, newCount: number): string {
  const parts: string[] = [];
  if (matched > 0) parts.push(`Tag ${matched} matched`);
  if (newCount > 0) parts.push(`Add ${newCount} new`);
  return parts.length > 0 ? parts.join(" + ") : "Apply";
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

function TabBar({ tabs, active, onChange }: {
  tabs: { id: SettingsTab; label: string }[];
  active: SettingsTab;
  onChange: (t: SettingsTab) => void;
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
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("integrations");
  const [ready, setReady] = useState(false);

  // ── Integrations state ──
  const [uid, setUid] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [gmailLabels, setGmailLabels] = useState("Jordan OS");
  const [sheetUrl, setSheetUrl] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; current: string; errors: number } | null>(null);
  const [coaching, setCoaching] = useState<CoachingResult | null>(null);
  const [coachedAt, setCoachedAt] = useState<string | null>(null);
  const [coachRunning, setCoachRunning] = useState(false);

  // ── LinkedIn state ──
  const [liRows, setLiRows] = useState<LinkedInRow[]>([]);
  const [liPreview, setLiPreview] = useState<PreviewResult | null>(null);
  const [liLoading, setLiLoading] = useState(false);
  const [liApplying, setLiApplying] = useState(false);
  const [liApplied, setLiApplied] = useState<AppliedResult | null>(null);
  const [liError, setLiError] = useState<string | null>(null);
  const [selectedUnmatched, setSelectedUnmatched] = useState<Set<number>>(new Set());
  const [newCategory, setNewCategory] = useState("Agent");
  const [newTier, setNewTier] = useState("B");
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Init ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    async function load() {
      const { data } = await supabase.auth.getSession();
      const user = data.session?.user;
      if (!user) { window.location.href = "/login"; return; }
      setUid(user.id);
      const { data: tData } = await supabase.from("google_tokens").select("user_id").eq("user_id", user.id).maybeSingle();
      setConnected(!!tData?.user_id);
      const { data: sData } = await supabase
        .from("user_settings")
        .select("gmail_label_names, sheet_url, voice_coaching_result, voice_coached_at")
        .eq("user_id", user.id)
        .maybeSingle();
      if (sData?.gmail_label_names) setGmailLabels(sData.gmail_label_names);
      if (sData?.sheet_url) setSheetUrl(sData.sheet_url);
      if (sData?.voice_coaching_result) setCoaching(sData.voice_coaching_result as any);
      if (sData?.voice_coached_at) setCoachedAt(sData.voice_coached_at);
      setReady(true);
    }
    load();
  }, []);

  // ── Integrations actions ──────────────────────────────────────────────────

  async function connectGoogle() {
    if (!uid) return;
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/google/oauth/start?uid=${uid}`);
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j?.error || "Failed to start OAuth"); return; }
    window.location.href = j.url;
  }

  async function saveSettings() {
    if (!uid) return;
    setBusy(true);
    setErr(null);
    const { error } = await supabase.from("user_settings").upsert(
      { user_id: uid, gmail_label_names: gmailLabels, sheet_url: sheetUrl.trim() || null, updated_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
    setBusy(false);
    if (error) setErr(error.message);
    else { setMsg("Saved."); setSettingsOpen(false); }
  }

  async function runGmailSync() {
    if (!uid) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    const res = await fetch(`/api/gmail/sync?uid=${uid}`);
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j?.error || "Sync failed"); return; }
    const saveNote = j.unmatchedSaveError ? ` (save error: ${j.unmatchedSaveError})` : "";
    setMsg(`Gmail sync done — ${j.imported} imported, ${j.unmatchedEmailsQueued ?? j.unmatched} unmatched queued${saveNote}`);
  }

  async function syncVoiceExamples() {
    if (!uid) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    const res = await fetch(`/api/voice/sync_gmail_sent?uid=${uid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: 365, maxMessages: 600 }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j?.error || "Voice sync failed"); return; }
    setMsg(`Voice sync done — ${j.inserted} added, ${j.skipped} skipped (${j.scanned} scanned)`);
  }

  async function importSheet() {
    if (!uid) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    const res = await fetch(`/api/sheets/import?uid=${uid}`);
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(j?.error || "Import failed"); return; }
    setMsg(`Sheet import done — ${j.upserted} contacts upserted`);
  }

  async function runBulkExtract() {
    if (!uid) return;
    setBulkRunning(true);
    setBulkProgress(null);
    setErr(null);
    setMsg(null);
    const res = await fetch(`/api/contacts/extract_context_bulk?uid=${uid}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(j?.error || "Failed to fetch contacts"); setBulkRunning(false); return; }
    const contacts: { id: string; display_name: string; already_extracted: boolean }[] = j.contacts ?? [];
    if (contacts.length === 0) { setMsg("No contacts with text threads found."); setBulkRunning(false); return; }
    let done = 0;
    let errors = 0;
    for (const c of contacts) {
      setBulkProgress({ done, total: contacts.length, current: c.display_name, errors });
      try {
        const r = await fetch("/api/contacts/extract_context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uid, contact_id: c.id }),
        });
        if (!r.ok) errors++;
      } catch { errors++; }
      done++;
      setBulkProgress({ done, total: contacts.length, current: c.display_name, errors });
    }
    setBulkRunning(false);
    setMsg(`Extraction complete — ${done - errors}/${done} contacts updated${errors > 0 ? `, ${errors} failed` : ""}.`);
    setBulkProgress(null);
  }

  async function runVoiceCoach() {
    if (!uid) return;
    setCoachRunning(true);
    setErr(null);
    setMsg(null);
    const res = await fetch("/api/voice/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid }),
    });
    const j = await res.json().catch(() => ({}));
    setCoachRunning(false);
    if (!res.ok) { setErr(j?.error || "Voice coach failed"); return; }
    setCoaching(j.coaching);
    setCoachedAt(new Date().toISOString());
    setMsg(`Analysis complete — ${j.examples_analyzed} emails analyzed.`);
  }

  // ── LinkedIn actions ──────────────────────────────────────────────────────

  function handleFile(file: File) {
    setLiError(null);
    setLiPreview(null);
    setLiApplied(null);
    setSelectedUnmatched(new Set());
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const parsed = parseLinkedInCSV(text);
      if (parsed.length === 0) {
        setLiError("Couldn't parse CSV. Make sure you uploaded the LinkedIn Connections export (Connections.csv).");
        return;
      }
      setLiRows(parsed);
    };
    reader.readAsText(file);
  }

  async function runPreview() {
    if (liRows.length === 0) return;
    setLiLoading(true);
    setLiError(null);
    setSelectedUnmatched(new Set());
    try {
      const res = await fetch("/api/linkedin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: liRows, apply: false }),
      });
      const j = await res.json();
      if (!res.ok) { setLiError(j.error ?? "Preview failed"); return; }
      setLiPreview(j as PreviewResult);
    } catch (e: any) {
      setLiError(e?.message ?? "Preview failed");
    } finally {
      setLiLoading(false);
    }
  }

  async function applyImport() {
    if (!liPreview || liRows.length === 0) return;
    setLiApplying(true);
    setLiError(null);
    try {
      const selectedItems = Array.from(selectedUnmatched).map((i) => ({
        ...liPreview.unmatchedContacts[i]!,
        category: newCategory,
        tier: newTier,
      }));
      const res = await fetch("/api/linkedin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: liRows, apply: true, selectedToCreate: selectedItems }),
      });
      const j = await res.json();
      if (!res.ok) { setLiError(j.error ?? "Apply failed"); return; }
      setLiApplied({ tagged: j.applied, created: j.created ?? 0 });
      setLiPreview(null);
      setLiRows([]);
      setSelectedUnmatched(new Set());
    } catch (e: any) {
      setLiError(e?.message ?? "Apply failed");
    } finally {
      setLiApplying(false);
    }
  }

  function toggleUnmatched(i: number) {
    const s = new Set(selectedUnmatched);
    if (s.has(i)) s.delete(i); else s.add(i);
    setSelectedUnmatched(s);
  }

  function toggleSelectAll(total: number) {
    if (selectedUnmatched.size === total) setSelectedUnmatched(new Set());
    else setSelectedUnmatched(new Set(Array.from({ length: total }, (_, i) => i)));
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (!ready) return <div className="page">Loading…</div>;

  const TABS: { id: SettingsTab; label: string }[] = [
    { id: "integrations", label: "Integrations" },
    { id: "linkedin", label: "LinkedIn" },
  ];

  return (
    <div className="stack">
      <h1 className="h1">Settings</h1>

      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      {/* ── Integrations tab ─────────────────────────────────────────────── */}
      {tab === "integrations" && (
        <div className="stack">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="badge" style={{ borderColor: connected ? "#86efac" : "#fca5a5", color: connected ? "#15803d" : "#b91c1c" }}>
              Google {connected ? "connected" : "not connected"}
            </span>
            {!connected && (
              <button className="btn btnPrimary" style={{ fontSize: 13 }} onClick={connectGoogle} disabled={busy}>
                Connect
              </button>
            )}
          </div>

          {err && <div className="alert alertError">{err}</div>}
          {msg && (
            <div style={{ padding: "10px 14px", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, fontSize: 14, color: "#15803d", fontWeight: 600 }}>
              {msg}
            </div>
          )}

          {/* Sync */}
          <div className="card cardPad">
            <div style={{ fontWeight: 900, marginBottom: 12 }}>Sync</div>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button className="btn" onClick={runGmailSync} disabled={busy || !connected}>
                {busy ? "Working…" : "Sync Gmail touches"}
              </button>
              <button className="btn" onClick={syncVoiceExamples} disabled={busy || !connected}>
                Sync voice examples
              </button>
              <button className="btn" onClick={importSheet} disabled={busy || !connected}>
                Import master sheet
              </button>
            </div>
            <div className="muted small" style={{ marginTop: 8 }}>
              To sync calendar meetings and review unmatched events, go to{" "}
              <a href="/review?tab=calendar" style={{ fontWeight: 700 }}>Review → Calendar</a>.
            </div>
          </div>

          {/* Bulk extraction */}
          <div className="card cardPad">
            <div style={{ fontWeight: 900, marginBottom: 4 }}>Extract contact context</div>
            <div className="muted small" style={{ marginBottom: 12 }}>
              Runs AI extraction on all contacts with uploaded text threads — pulls real estate context, personal details, and follow-ups into each contact card.
            </div>
            {bulkProgress && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
                  <span style={{ fontWeight: 700 }}>{bulkProgress.current}</span>
                  <span className="muted">{bulkProgress.done} / {bulkProgress.total}</span>
                </div>
                <div style={{ height: 6, background: "rgba(0,0,0,0.07)", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${Math.round((bulkProgress.done / bulkProgress.total) * 100)}%`, height: "100%", background: "#15803d", borderRadius: 4, transition: "width 0.2s" }} />
                </div>
                {bulkProgress.errors > 0 && (
                  <div style={{ fontSize: 12, color: "#b91c1c", marginTop: 4 }}>{bulkProgress.errors} failed so far</div>
                )}
              </div>
            )}
            <button className="btn" onClick={runBulkExtract} disabled={bulkRunning || !connected}>
              {bulkRunning ? "Extracting…" : "Run bulk extraction"}
            </button>
          </div>

          {/* Voice coaching */}
          <div className="card cardPad">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
              <div>
                <div style={{ fontWeight: 900 }}>Voice coaching</div>
                {coachedAt && (
                  <div className="muted small" style={{ marginTop: 2 }}>
                    Last analyzed {new Date(coachedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </div>
                )}
              </div>
              <button className="btn" style={{ fontSize: 12 }} onClick={runVoiceCoach} disabled={coachRunning || !connected}>
                {coachRunning ? "Analyzing…" : coaching ? "Re-analyze" : "Analyze my outreach style"}
              </button>
            </div>
            <div className="muted small" style={{ marginBottom: coaching ? 16 : 12 }}>
              Analyzes your synced emails with AI to identify your communication style, score it, and give specific improvement recommendations.
            </div>
            {coaching && (
              <div className="stack">
                <div style={{ fontSize: 14, lineHeight: 1.55 }}>
                  <span style={{ fontWeight: 700 }}>Style summary: </span>{coaching.style_summary}
                </div>
                <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                  {Object.entries(coaching.score || {}).map(([k, v]) => (
                    <div key={k} style={{ textAlign: "center", minWidth: 60 }}>
                      <div style={{ fontSize: 20, fontWeight: 900, color: Number(v) >= 7 ? "#15803d" : Number(v) >= 5 ? "#b45309" : "#b91c1c" }}>{v}/10</div>
                      <div style={{ fontSize: 11, color: "#888", textTransform: "capitalize" }}>{k}</div>
                    </div>
                  ))}
                </div>
                {coaching.strengths?.length > 0 && (
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>What's working</div>
                    <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
                      {coaching.strengths.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </div>
                )}
                {coaching.improvements?.length > 0 && (
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Improvements</div>
                    <div className="stack">
                      {coaching.improvements.map((imp, i) => (
                        <div key={i} style={{ padding: "10px 12px", background: "rgba(0,0,0,0.03)", borderRadius: 8, fontSize: 13 }}>
                          <div style={{ fontWeight: 700, marginBottom: 4 }}>{imp.issue}</div>
                          <div style={{ color: "#444", marginBottom: imp.example ? 6 : 0 }}>{imp.recommendation}</div>
                          {imp.example && <div style={{ fontStyle: "italic", color: "#666", fontSize: 12 }}>{imp.example}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Settings */}
          <div className="card cardPad">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontWeight: 900 }}>Gmail &amp; Sheet settings</div>
              <button className="btn" style={{ fontSize: 12 }} onClick={() => setSettingsOpen((v) => !v)}>
                {settingsOpen ? "Close" : "Edit"}
              </button>
            </div>
            {!settingsOpen && (
              <div style={{ marginTop: 8, fontSize: 13, color: "#666" }}>
                Gmail label: <strong>{gmailLabels || "—"}</strong>
                {sheetUrl && <span style={{ marginLeft: 12 }}>Sheet: <strong>configured</strong></span>}
              </div>
            )}
            {settingsOpen && (
              <div className="stack" style={{ marginTop: 12 }}>
                <div className="field">
                  <div className="label">Gmail label names (comma separated)</div>
                  <input className="input" value={gmailLabels} onChange={(e) => setGmailLabels(e.target.value)} placeholder="Jordan OS" />
                </div>
                <div className="field">
                  <div className="label">Master Google Sheet URL</div>
                  <input className="input" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/..." />
                </div>
                <div className="row">
                  <button className="btn btnPrimary" onClick={saveSettings} disabled={busy}>Save</button>
                  <button className="btn" onClick={() => setSettingsOpen(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── LinkedIn tab ─────────────────────────────────────────────────── */}
      {tab === "linkedin" && (
        <div className="stack">
          <div className="muted small">
            Match your LinkedIn connections to CRM contacts and tag them for scoring.
          </div>

          {/* Instructions */}
          <div className="card cardPad">
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>How to export from LinkedIn</div>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.8, color: "rgba(18,18,18,.7)" }}>
              <li>Go to LinkedIn → Me → Settings &amp; Privacy</li>
              <li>Data Privacy → Get a copy of your data</li>
              <li>Select <strong>Connections</strong> and request archive</li>
              <li>Download the zip, extract, and upload <strong>Connections.csv</strong> below</li>
            </ol>
          </div>

          {liError && (
            <div className="card cardPad" style={{ borderColor: "rgba(200,0,0,.2)", background: "rgba(200,0,0,.03)" }}>
              <div style={{ color: "#8a0000", fontWeight: 700, fontSize: 13 }}>{liError}</div>
            </div>
          )}

          {liApplied !== null && (
            <div className="card cardPad" style={{ borderColor: "rgba(11,107,42,.2)", background: "rgba(11,107,42,.04)" }}>
              <div style={{ fontWeight: 900, color: "#0b6b2a", fontSize: 15 }}>
                {[
                  liApplied.tagged > 0 && `${liApplied.tagged} contact${liApplied.tagged !== 1 ? "s" : ""} tagged as LinkedIn connections`,
                  liApplied.created > 0 && `${liApplied.created} new contact${liApplied.created !== 1 ? "s" : ""} added`,
                ].filter(Boolean).map((msg, i) => <div key={i}>✓ {msg}</div>)}
              </div>
              <div className="muted small" style={{ marginTop: 4 }}>
                Tagged contacts get a scoring boost in your Morning recommendations.
              </div>
              <div className="row" style={{ marginTop: 12, gap: 8 }}>
                <a className="btn btnPrimary" href="/morning">Go to Morning →</a>
                <button className="btn" onClick={() => { setLiApplied(null); setLiError(null); }}>Import another file</button>
              </div>
            </div>
          )}

          {liApplied === null && (
            <>
              <div
                className="card cardPad"
                style={{ cursor: "pointer", textAlign: "center", padding: "32px 24px" }}
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files[0]; if (file) handleFile(file); }}
              >
                <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
                {liRows.length > 0 ? (
                  <>
                    <div style={{ fontWeight: 900, fontSize: 16, color: "#0b6b2a" }}>✓ {liRows.length} connections loaded</div>
                    <div className="muted small" style={{ marginTop: 4 }}>Click to choose a different file</div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>⬆</div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>Drop Connections.csv here or click to browse</div>
                    <div className="muted small" style={{ marginTop: 4 }}>LinkedIn CSV export · .csv files only</div>
                  </>
                )}
              </div>

              {liRows.length > 0 && !liPreview && (
                <button
                  className="btn btnPrimary"
                  style={{ width: "100%", justifyContent: "center", fontSize: 15, padding: "12px" }}
                  onClick={runPreview}
                  disabled={liLoading}
                >
                  {liLoading ? "Matching connections…" : `Match ${liRows.length} connections against CRM`}
                </button>
              )}
            </>
          )}

          {liPreview && (
            <div className="stack">
              <div className="card cardPad">
                <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 12 }}>Match results</div>
                <div className="row" style={{ gap: 24, flexWrap: "wrap", marginBottom: 16 }}>
                  <div><div style={{ fontSize: 28, fontWeight: 900, color: "#0b6b2a" }}>{liPreview.matched}</div><div className="muted small">matched in CRM</div></div>
                  <div><div style={{ fontSize: 28, fontWeight: 900, color: "rgba(18,18,18,.4)" }}>{liPreview.unmatched}</div><div className="muted small">not in CRM</div></div>
                  <div><div style={{ fontSize: 28, fontWeight: 900 }}>{liPreview.total}</div><div className="muted small">total connections</div></div>
                </div>
                <div className="muted small" style={{ marginBottom: 16 }}>
                  Matched contacts will be tagged with their LinkedIn connection date. Select unmatched connections below to add them as new contacts.
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button
                    className="btn btnPrimary"
                    style={{ fontSize: 14, padding: "10px 20px" }}
                    onClick={applyImport}
                    disabled={liApplying || (liPreview.matched === 0 && selectedUnmatched.size === 0)}
                  >
                    {liApplying ? "Applying…" : buildApplyLabel(liPreview.matched, selectedUnmatched.size)}
                  </button>
                  <button className="btn" onClick={() => { setLiPreview(null); setLiRows([]); setSelectedUnmatched(new Set()); }}>Cancel</button>
                </div>
              </div>

              {liPreview.matchedContacts.length > 0 && (
                <div>
                  <div className="sectionTitle" style={{ marginBottom: 8 }}>
                    Matched contacts ({liPreview.matchedContacts.length}{liPreview.matched > 200 ? "+" : ""})
                  </div>
                  <div className="stack">
                    {liPreview.matchedContacts.map((m, i) => (
                      <div key={i} className="card cardPad" style={{ padding: "8px 12px" }}>
                        <div className="rowBetween">
                          <div>
                            <span style={{ fontWeight: 800, fontSize: 14 }}>{m.display_name}</span>
                            {m.display_name !== m.linkedin_name && (
                              <span className="muted small" style={{ marginLeft: 6 }}>LinkedIn: {m.linkedin_name}</span>
                            )}
                          </div>
                          <div className="row" style={{ gap: 6 }}>
                            <span className="badge" style={{ fontSize: 11 }}>{m.match_type === "email" ? "Email match" : "Name match"}</span>
                            {m.connected_on && <span className="badge" style={{ fontSize: 11 }}>Connected {m.connected_on}</span>}
                          </div>
                        </div>
                        {(m.company || m.position) && (
                          <div className="muted small" style={{ marginTop: 2 }}>{[m.position, m.company].filter(Boolean).join(" · ")}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {liPreview.unmatchedContacts.length > 0 && (
                <div>
                  <div className="rowBetween" style={{ marginBottom: 8 }}>
                    <div className="sectionTitle">Not in CRM ({liPreview.unmatched}{liPreview.unmatched > 100 ? ", showing first 100" : ""})</div>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", userSelect: "none" }}>
                      <input
                        type="checkbox"
                        checked={selectedUnmatched.size === liPreview.unmatchedContacts.length && liPreview.unmatchedContacts.length > 0}
                        onChange={() => toggleSelectAll(liPreview.unmatchedContacts.length)}
                      />
                      Select all
                    </label>
                  </div>
                  <div className="stack">
                    {liPreview.unmatchedContacts.map((u, i) => (
                      <label key={i} className="card cardPad" style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none" }}>
                        <input type="checkbox" checked={selectedUnmatched.has(i)} onChange={() => toggleUnmatched(i)} style={{ flexShrink: 0 }} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{u.linkedin_name}</div>
                          {(u.email || u.company || u.position) && (
                            <div className="muted small" style={{ marginTop: 2, fontSize: 12 }}>{[u.position, u.company, u.email].filter(Boolean).join(" · ")}</div>
                          )}
                        </div>
                      </label>
                    ))}
                  </div>
                  {selectedUnmatched.size > 0 && (
                    <div className="card cardPad" style={{ marginTop: 8 }}>
                      <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 10 }}>Add {selectedUnmatched.size} selected as new contacts</div>
                      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                        <div className="field">
                          <div className="label">Category</div>
                          <select className="select" value={newCategory} onChange={(e) => setNewCategory(e.target.value)}>
                            <option>Agent</option><option>Client</option><option>Sphere</option><option>Developer</option><option>Vendor</option><option>Other</option>
                          </select>
                        </div>
                        <div className="field">
                          <div className="label">Tier</div>
                          <select className="select" value={newTier} onChange={(e) => setNewTier(e.target.value)}>
                            <option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
