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

    // Check if google_tokens exists for user
    const { data: tData, error: tErr } = await supabase
      .from("google_tokens")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (tErr) setErr(tErr.message);
    setConnected(!!tData?.user_id);

    // Load settings
    const { data: sData, error: sErr } = await supabase
      .from("user_settings")
      .select("gmail_label_names, sheet_url")
      .eq("user_id", user.id)
      .maybeSingle();

    if (sErr) setErr((prev) => prev ?? sErr.message);

    if (sData?.gmail_label_names) setGmailLabels(sData.gmail_label_names);
    if (sData?.sheet_url) setSheetUrl(sData.sheet_url);

    setReady(true);
  }

  async function connectGoogle() {
    setErr(null);
    setMsg(null);
    if (!uid) return;

    const res = await fetch(`/api/google/oauth/start?uid=${uid}`);

    const rawText = await res.text();
    let j: any = null;
    try {
      j = JSON.parse(rawText);
    } catch {
      j = null;
    }

    if (!res.ok) {
      const base = j?.error || rawText || "Failed to start OAuth";
      const details = j?.details ? `\n\nDetails:\n${j.details}` : "";
      setErr(base + details);
      return;
    }

    if (!j?.url) {
      setErr("OAuth start returned unexpected response:\n" + rawText);
      return;
    }

    window.location.href = j.url;
  }

  async function saveSettings() {
    setErr(null);
    setMsg(null);
    if (!uid) return;

    const { error } = await supabase.from("user_settings").upsert(
      {
        user_id: uid,
        gmail_label_names: gmailLabels,
        sheet_url: sheetUrl.trim() ? sheetUrl.trim() : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    if (error) setErr(error.message);
    else setMsg("Saved.");
  }

  async function runGmailSync() {
    setErr(null);
    setMsg(null);
    if (!uid) return;

    const res = await fetch(`/api/gmail/sync?uid=${uid}`);

    const rawText = await res.text();
    let j: any = null;
    try {
      j = JSON.parse(rawText);
    } catch {
      j = null;
    }

    if (!res.ok) {
      const base = j?.error || rawText || `Sync failed (status ${res.status})`;
      const details = j?.details ? `\n\nDetails:\n${j.details}` : "";
      setErr(base + details);
      return;
    }

    if (!j) {
      setErr("Sync returned unexpected response:\n" + rawText);
      return;
    }

    setMsg(`Gmail sync complete.\n\nImported: ${j.imported}\nSkipped: ${j.skipped}\nUnmatched: ${j.unmatched}`);
  }

  async function importSheet() {
    setErr(null);
    setMsg(null);
    if (!uid) return;

    const res = await fetch(`/api/sheets/import?uid=${uid}`);

    const rawText = await res.text();
    let j: any = null;
    try {
      j = JSON.parse(rawText);
    } catch {
      j = null;
    }

    if (!res.ok) {
      const base = j?.error || rawText || `Import failed (status ${res.status})`;
      const details = j?.details ? `\n\nDetails:\n${j.details}` : "";
      setErr(base + details);
      return;
    }

    if (!j) {
      setErr("Import returned unexpected response:\n" + rawText);
      return;
    }

    setMsg(
      `Sheet import complete.\n\n` +
        `sheet=${j.sheet}\n` +
        `upserted=${j.upserted}\n` +
        `touchesCreated=${j.touchesCreated}\n` +
        `skipped=${j.skipped}\n` +
        (j.duplicatesAvoided != null ? `duplicatesAvoided=${j.duplicatesAvoided}\n` : "")
    );
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) return <div style={{ padding: 40 }}>Loading…</div>;

  return (
    <div style={{ padding: 40, maxWidth: 900 }}>
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 900 }}>Integrations</h1>
      <div style={{ color: "#666", marginTop: 8 }}>
        Google connection:{" "}
        <strong style={{ color: connected ? "green" : "crimson" }}>
          {connected ? "Connected" : "Not connected"}
        </strong>
      </div>

      {(err || msg) && (
        <div
          style={{
            marginTop: 14,
            color: err ? "crimson" : "green",
            fontWeight: 800,
            whiteSpace: "pre-wrap",
            background: "#fafafa",
            padding: 12,
            borderRadius: 10,
            border: "1px solid #eee",
          }}
        >
          {err || msg}
        </div>
      )}

      <div style={{ marginTop: 18, border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
        <div style={{ fontWeight: 900 }}>1) Connect Google</div>
        <div style={{ color: "#666", marginTop: 6 }}>
          One connection powers Gmail + Calendar + Sheets. (We’ll use label-based Gmail sync.)
        </div>
        <button
          onClick={connectGoogle}
          style={{
            marginTop: 10,
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #ddd",
            cursor: "pointer",
            fontWeight: 900,
          }}
        >
          Connect Google
        </button>
      </div>

      <div style={{ marginTop: 14, border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
        <div style={{ fontWeight: 900 }}>2) Settings</div>

        <div style={{ marginTop: 10 }}>
          <label style={{ display: "block", fontSize: 12, color: "#666" }}>
            Gmail label names (comma separated)
            <input
              value={gmailLabels}
              onChange={(e) => setGmailLabels(e.target.value)}
              placeholder="Jordan OS, CRM Outbound"
              style={{
                display: "block",
                width: "100%",
                padding: 10,
                marginTop: 6,
                borderRadius: 10,
                border: "1px solid #ddd",
              }}
            />
          </label>
        </div>

        <div style={{ marginTop: 10 }}>
          <label style={{ display: "block", fontSize: 12, color: "#666" }}>
            Master Google Sheet URL (one-time import)
            <input
              value={sheetUrl}
              onChange={(e) => setSheetUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              style={{
                display: "block",
                width: "100%",
                padding: 10,
                marginTop: 6,
                borderRadius: 10,
                border: "1px solid #ddd",
              }}
            />
          </label>
        </div>

        <button
          onClick={saveSettings}
          style={{
            marginTop: 12,
            padding: "10px 14px",
            borderRadius: 10,
            border: "1px solid #ddd",
            cursor: "pointer",
            fontWeight: 900,
          }}
        >
          Save settings
        </button>
      </div>

      <div style={{ marginTop: 14, border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
        <div style={{ fontWeight: 900 }}>3) Actions</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          <button
            onClick={runGmailSync}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: "pointer",
              fontWeight: 900,
            }}
          >
            Run Gmail sync (labels)
          </button>

          <button
            onClick={importSheet}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: "pointer",
              fontWeight: 900,
            }}
          >
            Import Master Sheet (one-time)
          </button>
        </div>

        <div style={{ color: "#666", marginTop: 8 }}>
          Gmail sync imports outbound email as touches only when the recipient matches a contact email in your CRM.
        </div>
      </div>
    </div>
  );
}