"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

export default function IntegrationsPage() {
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [gmailLabels, setGmailLabels] = useState("Jordan OS");
  const [sheetUrl, setSheetUrl] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // bulk extraction
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; current: string; errors: number } | null>(null);

  // voice coaching
  const [coaching, setCoaching] = useState<{
    style_summary: string;
    strengths: string[];
    improvements: { issue: string; recommendation: string; example?: string }[];
    style_guide: string;
    score: { warmth: number; clarity: number; brevity: number; relevance: number; overall: number };
  } | null>(null);
  const [coachRunning, setCoachRunning] = useState(false);

  async function load() {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) { window.location.href = "/login"; return; }
    setUid(user.id);

    const { data: tData } = await supabase.from("google_tokens").select("user_id").eq("user_id", user.id).maybeSingle();
    setConnected(!!tData?.user_id);

    const { data: sData } = await supabase.from("user_settings").select("gmail_label_names, sheet_url").eq("user_id", user.id).maybeSingle();
    if (sData?.gmail_label_names) setGmailLabels(sData.gmail_label_names);
    if (sData?.sheet_url) setSheetUrl(sData.sheet_url);

    setReady(true);
  }

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
    if (!res.ok) { setErr(j?.error || `Sync failed`); return; }
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
    setMsg(`Voice sync done — ${j.inserted} examples added`);
  }

  async function runBulkExtract() {
    if (!uid) return;
    setBulkRunning(true);
    setBulkProgress(null);
    setErr(null);
    setMsg(null);

    // Fetch contacts with text messages
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
      } catch {
        errors++;
      }
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
    setMsg(`Analysis complete — ${j.examples_analyzed} emails analyzed.`);
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

  useEffect(() => { load(); }, []);

  if (!ready) return <div className="page">Loading…</div>;

  return (
    <div className="page">
      <div className="pageHeader">
        <div>
          <h1 className="h1">Integrations</h1>
          <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}>
            <span className="badge" style={{ borderColor: connected ? "#86efac" : "#fca5a5", color: connected ? "#15803d" : "#b91c1c" }}>
              Google {connected ? "connected" : "not connected"}
            </span>
            {!connected && (
              <button className="btn btnPrimary" style={{ fontSize: 13 }} onClick={connectGoogle} disabled={busy}>
                Connect
              </button>
            )}
          </div>
        </div>
        <div className="row">
          <a className="btn" href="/morning">Morning</a>
          <a className="btn" href="/contacts">Contacts</a>
        </div>
      </div>

      {err && <div className="alert alertError">{err}</div>}
      {msg && <div style={{ padding: "10px 14px", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, fontSize: 14, color: "#15803d", fontWeight: 600 }}>{msg}</div>}

      {/* Actions */}
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
              <div style={{
                width: `${Math.round((bulkProgress.done / bulkProgress.total) * 100)}%`,
                height: "100%", background: "#15803d", borderRadius: 4, transition: "width 0.2s"
              }} />
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
        <div style={{ fontWeight: 900, marginBottom: 4 }}>Voice coaching</div>
        <div className="muted small" style={{ marginBottom: 12 }}>
          Analyzes your synced emails with AI to identify your communication style, score it, and give specific improvement recommendations. Also generates a style guide used for future drafts.
        </div>

        <button className="btn" onClick={runVoiceCoach} disabled={coachRunning || !connected}>
          {coachRunning ? "Analyzing…" : "Analyze my outreach style"}
        </button>

        {coaching && (
          <div className="stack" style={{ marginTop: 16 }}>
            <div style={{ fontSize: 14, lineHeight: 1.55 }}>
              <span style={{ fontWeight: 700 }}>Style summary: </span>{coaching.style_summary}
            </div>

            {/* Scores */}
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              {Object.entries(coaching.score || {}).map(([k, v]) => (
                <div key={k} style={{ textAlign: "center", minWidth: 60 }}>
                  <div style={{ fontSize: 20, fontWeight: 900, color: Number(v) >= 7 ? "#15803d" : Number(v) >= 5 ? "#b45309" : "#b91c1c" }}>{v}/10</div>
                  <div style={{ fontSize: 11, color: "#888", textTransform: "capitalize" }}>{k}</div>
                </div>
              ))}
            </div>

            {/* Strengths */}
            {coaching.strengths?.length > 0 && (
              <div>
                <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>What's working</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
                  {coaching.strengths.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}

            {/* Improvements */}
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

            <button className="btn" style={{ fontSize: 12, alignSelf: "flex-start" }} onClick={runVoiceCoach} disabled={coachRunning}>
              Re-analyze
            </button>
          </div>
        )}
      </div>

      {/* Settings */}
      <div className="card cardPad">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 900 }}>Settings</div>
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
  );
}
