"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

export default function IntegrationsPage() {
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);

  const [connected, setConnected] = useState(false);
  const [gmailLabels, setGmailLabels] = useState("Jordan OS");
  const [sheetUrl, setSheetUrl] = useState("");

  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    setMsg(null);

    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) {
      window.location.href = "/login";
      return;
    }

    setUid(user.id);

    // Check if google_tokens exists
    const { data: tData, error: tErr } = await supabase
      .from("google_tokens")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (tErr) setErr(tErr.message);
    setConnected(!!tData?.user_id);

    // Load settings
    const { data: sData } = await supabase
      .from("user_settings")
      .select("gmail_label_names, sheet_url")
      .eq("user_id", user.id)
      .maybeSingle();

    if (sData?.gmail_label_names) setGmailLabels(sData.gmail_label_names);
    if (sData?.sheet_url) setSheetUrl(sData.sheet_url);

    setReady(true);
  }

  async function connectGoogle() {
    setErr(null);
    setMsg(null);
    if (!uid) return;

    setBusy(true);
    const res = await fetch(`/api/google/oauth/start?uid=${uid}`);
    const j = await res.json().catch(() => ({}));
    setBusy(false);

    if (!res.ok) {
      setErr(j?.error || "Failed to start OAuth");
      return;
    }
    window.location.href = j.url;
  }

  async function saveSettings() {
    setErr(null);
    setMsg(null);
    if (!uid) return;

    setBusy(true);
    const { error } = await supabase.from("user_settings").upsert(
      {
        user_id: uid,
        gmail_label_names: gmailLabels,
        sheet_url: sheetUrl.trim() ? sheetUrl.trim() : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    setBusy(false);

    if (error) setErr(error.message);
    else setMsg("Saved.");
  }

  async function runGmailSync() {
    setErr(null);
    setMsg(null);
    if (!uid) return;

    setBusy(true);
    const res = await fetch(`/api/gmail/sync?uid=${uid}`);
    const j = await res.json().catch(() => ({}));
    setBusy(false);

    if (!res.ok) {
      setErr(j?.error || `Sync failed (status ${res.status})`);
      return;
    }

    // Show full JSON if you want later; keep concise for now
    setMsg(
      `Gmail sync complete.\nImported: ${j.imported}\nSkipped: ${j.skipped}\nUnmatched: ${j.unmatched}\nMessagesFetched: ${j.messagesFetched ?? "—"}`
    );
  }

  async function importSheet() {
    setErr(null);
    setMsg(null);
    if (!uid) return;

    setBusy(true);
    const res = await fetch(`/api/sheets/import?uid=${uid}`);
    const j = await res.json().catch(() => ({}));
    setBusy(false);

    if (!res.ok) {
      setErr(j?.error || "Import failed");
      return;
    }
    setMsg(`Sheet import complete.\nUpserted: ${j.upserted}\nSkipped: ${j.skipped}`);
  }

  async function syncVoiceExamples() {
    setErr(null);
    setMsg(null);
    if (!uid) return;

    setBusy(true);
    const res = await fetch(`/api/voice/sync_gmail_sent?uid=${uid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: 365, maxMessages: 600 }),
    });
    const j = await res.json().catch(() => ({}));
    setBusy(false);

    if (!res.ok) {
      setErr(j?.error || "Voice sync failed");
      return;
    }

    setMsg(
      `Voice sync complete.\nScanned: ${j.scanned}\nInserted: ${j.inserted}\nSkipped: ${j.skipped}\nQuery: ${j.usedQuery}`
    );
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) return <div className="page">Loading…</div>;

  return (
    <div className="page">
      <div className="pageHeader">
        <div>
          <h1 className="h1">Integrations</h1>
          <div className="muted" style={{ marginTop: 8 }}>
            Google connection:{" "}
            <span className="badge" style={{ borderColor: connected ? "rgba(11,107,42,0.35)" : "rgba(138,0,0,0.35)" }}>
              {connected ? "Connected" : "Not connected"}
            </span>
          </div>
        </div>

        <div className="row">
          <a className="btn" href="/morning">
            Morning
          </a>
          <a className="btn" href="/contacts">
            Contacts
          </a>
          <a className="btn" href="/unmatched">
            Unmatched
          </a>
        </div>
      </div>

      {(err || msg) && (
        <div className="card cardPad" style={{ borderColor: err ? "rgba(160,0,0,0.25)" : undefined }}>
          <div style={{ fontWeight: 900, color: err ? "#8a0000" : "#0b6b2a", whiteSpace: "pre-wrap" }}>{err || msg}</div>
        </div>
      )}

      <div className="section">
        <div className="sectionTitleRow">
          <div className="sectionTitle">1) Connect Google</div>
          <div className="sectionSub">One connection powers Gmail + Sheets.</div>
        </div>
        <button className="btn btnPrimary" onClick={connectGoogle} disabled={busy}>
          {busy ? "Working…" : "Connect Google"}
        </button>
      </div>

      <div className="section">
        <div className="sectionTitleRow">
          <div className="sectionTitle">2) Settings</div>
          <div className="sectionSub">Labels for Gmail sync + sheet URL for one-time import.</div>
        </div>

        <div className="stack">
          <label className="field">
            <div className="label">Gmail label names (comma separated)</div>
            <input className="input" value={gmailLabels} onChange={(e) => setGmailLabels(e.target.value)} placeholder="Jordan OS, CRM Outbound" />
          </label>

          <label className="field">
            <div className="label">Master Google Sheet URL (one-time import)</div>
            <input className="input" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/..." />
          </label>

          <button className="btn" onClick={saveSettings} disabled={busy}>
            Save settings
          </button>
        </div>
      </div>

      <div className="section">
        <div className="sectionTitleRow">
          <div className="sectionTitle">3) Actions</div>
          <div className="sectionSub">Sync touches + build your writing style automatically.</div>
        </div>

        <div className="row">
          <button className="btn" onClick={runGmailSync} disabled={busy}>
            Run Gmail sync (touches)
          </button>
          <button className="btn" onClick={syncVoiceExamples} disabled={busy}>
            Sync Gmail → Voice Examples
          </button>
          <button className="btn" onClick={importSheet} disabled={busy}>
            Import Master Sheet (one-time)
          </button>
        </div>

        <div className="muted small" style={{ marginTop: 10 }}>
          “Voice Examples” are pulled from your Sent mail and used to make the recommended outreach sound like you over time.
        </div>
      </div>
    </div>
  );
}