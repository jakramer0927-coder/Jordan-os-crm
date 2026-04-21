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

  // calendar sync + review queue
  const [calSyncing, setCalSyncing] = useState(false);
  const [calSyncedAt, setCalSyncedAt] = useState<string | null>(null);

  type ReviewItem = {
    id: string;
    event_title: string;
    occurred_at: string;
    attendee_emails: string[];
    attendee_names: string[];
  };
  const [reviewQueue, setReviewQueue] = useState<ReviewItem[]>([]);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const [linkQuery, setLinkQuery] = useState<Record<string, string>>({});
  const [linkResults, setLinkResults] = useState<Record<string, { id: string; display_name: string }[]>>({});
  const [linkWorking, setLinkWorking] = useState<string | null>(null);

  async function loadReviewQueue() {
    const res = await fetch("/api/calendar/review");
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      setReviewQueue(j.items ?? []);
    }
  }

  async function searchContacts(itemId: string, q: string) {
    setLinkQuery((prev) => ({ ...prev, [itemId]: q }));
    if (q.trim().length < 2) { setLinkResults((prev) => ({ ...prev, [itemId]: [] })); return; }
    const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(q)}`);
    if (res.ok) {
      const j = await res.json().catch(() => ({}));
      setLinkResults((prev) => ({ ...prev, [itemId]: j.contacts ?? [] }));
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
    if (res.ok) {
      setReviewQueue((prev) => prev.filter((i) => i.id !== itemId));
      setLinkingId(null);
    }
  }

  async function dismissItem(itemId: string) {
    setLinkWorking(itemId);
    await fetch("/api/calendar/review", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: itemId, action: "dismiss" }),
    });
    setLinkWorking(null);
    setReviewQueue((prev) => prev.filter((i) => i.id !== itemId));
  }

  async function runCalendarSync() {
    if (!uid) return;
    setCalSyncing(true);
    setErr(null);
    setMsg(null);
    const res = await fetch("/api/calendar/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: 90 }),
    });
    const j = await res.json().catch(() => ({}));
    setCalSyncing(false);
    if (!res.ok) { setErr(j?.error || "Calendar sync failed"); return; }
    setCalSyncedAt(new Date().toISOString());
    setMsg(`Calendar sync done — ${j.imported} imported, ${j.unmatched_queued ?? 0} unmatched queued for review`);
    await loadReviewQueue();
  }

  // bulk extraction
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number; current: string; errors: number } | null>(null);

  // voice coaching
  type CoachingResult = {
    style_summary: string;
    strengths: string[];
    improvements: { issue: string; recommendation: string; example?: string }[];
    style_guide: string;
    score: { warmth: number; clarity: number; brevity: number; relevance: number; overall: number };
  };
  const [coaching, setCoaching] = useState<CoachingResult | null>(null);
  const [coachedAt, setCoachedAt] = useState<string | null>(null);
  const [coachRunning, setCoachRunning] = useState(false);

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
    await loadReviewQueue();
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
    setMsg(`Voice sync done — ${j.inserted} added, ${j.skipped} skipped (${j.scanned} scanned)`);
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
    setCoachedAt(new Date().toISOString());
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
          <button className="btn" onClick={runCalendarSync} disabled={calSyncing || !connected}>
            {calSyncing ? "Syncing…" : calSyncedAt ? "Re-sync calendar" : "Sync calendar meetings"}
          </button>
        </div>
        {calSyncedAt && (
          <div className="muted small" style={{ marginTop: 8 }}>
            Last synced {new Date(calSyncedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} — imports meetings from the past 90 days as touches
          </div>
        )}
      </div>

      {/* Calendar review queue */}
      {reviewQueue.length > 0 && (
        <div className="card cardPad">
          <div style={{ fontWeight: 900, marginBottom: 4 }}>Unmatched meetings — {reviewQueue.length} need review</div>
          <div className="muted small" style={{ marginBottom: 14 }}>
            These calendar events had attendees but no email match in your CRM. Link each one to a contact to log the touch, or dismiss.
          </div>
          <div className="stack" style={{ gap: 0 }}>
            {reviewQueue.map((item, i) => {
              const isLinking = linkingId === item.id;
              const working = linkWorking === item.id;
              const date = new Date(item.occurred_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
              const attendees = item.attendee_names.length > 0 ? item.attendee_names : item.attendee_emails;
              return (
                <div key={item.id} style={{ padding: "12px 0", borderBottom: i < reviewQueue.length - 1 ? "1px solid rgba(0,0,0,.06)" : undefined }}>
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
                        onChange={(e) => searchContacts(item.id, e.target.value)}
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
          Analyzes your synced emails with AI to identify your communication style, score it, and give specific improvement recommendations. Also generates a style guide used for future drafts.
        </div>

        {coaching && (
          <div className="stack">
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
