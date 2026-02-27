"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

export default function IntegrationsPage() {
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);

  const [connected, setConnected] = useState(false);
  const [gmailLabels, setGmailLabels] = useState("Jordan OS");
  const [sheetUrl, setSheetUrl] = useState("");

  const [ignoreDomains, setIgnoreDomains] = useState("smithandberg.com");
  const [ignoreEmails, setIgnoreEmails] = useState("");

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

    const { data: tData, error: tErr } = await supabase
      .from("google_tokens")
      .select("user_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (tErr) setErr(tErr.message);
    setConnected(!!tData?.user_id);

    const { data: sData, error: sErr } = await supabase
      .from("user_settings")
      .select("gmail_label_names, sheet_url, gmail_ignore_domains, gmail_ignore_emails")
      .eq("user_id", user.id)
      .maybeSingle();

    if (sErr) setErr(sErr.message);

    if (sData?.gmail_label_names) setGmailLabels(sData.gmail_label_names);
    if (sData?.sheet_url) setSheetUrl(sData.sheet_url);
    if (sData?.gmail_ignore_domains) setIgnoreDomains(sData.gmail_ignore_domains);
    if (sData?.gmail_ignore_emails) setIgnoreEmails(sData.gmail_ignore_emails);

    setReady(true);
  }

  async function connectGoogle() {
    setErr(null);
    setMsg(null);
    if (!uid) return;

    const res = await fetch(`/api/google/oauth/start?uid=${uid}`);
    const j = await res.json();
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

    const { error } = await supabase.from("user_settings").upsert(
      {
        user_id: uid,
        gmail_label_names: gmailLabels,
        gmail_ignore_domains: ignoreDomains.trim() ? ignoreDomains.trim() : null,
        gmail_ignore_emails: ignoreEmails.trim() ? ignoreEmails.trim() : null,
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
    const j = await res.json().catch(() => null);

    if (!res.ok) {
      setErr(j?.error || `Sync failed (status ${res.status})`);
      return;
    }

    setMsg(
      `Gmail sync complete. imported=${j.imported} skipped=${j.skipped} unmatched=${j.unmatched} (fetched=${j.messagesFetched ?? "?"})`
    );
  }

  async function importSheet() {
    setErr(null);
    setMsg(null);
    if (!uid) return;

    const res = await fetch(`/api/sheets/import?uid=${uid}`);
    const j = await res.json();
    if (!res.ok) {
      setErr(j?.error || "Import failed");
      return;
    }
    setMsg(`Sheet import complete. Upserted: ${j.upserted}, skipped: ${j.skipped}`);
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
        <div style={{ marginTop: 14, color: err ? "crimson" : "green", fontWeight: 800 }}>
          {err || msg}
        </div>
      )}

      <div style={{ marginTop: 18, border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
        <div style={{ fontWeight: 900 }}>1) Connect Google</div>
        <div style={{ color: "#666", marginTop: 6 }}>
          One connection powers Gmail + Calendar + Sheets.
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
            Ignore domains (comma separated)
            <input
              value={ignoreDomains}
              onChange={(e) => setIgnoreDomains(e.target.value)}
              placeholder="smithandberg.com, compass.com"
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
          <div style={{ marginTop: 6, color: "#777", fontSize: 12 }}>
            Any recipient in these domains will not count toward unmatched or import.
          </div>
        </div>

        <div style={{ marginTop: 10 }}>
          <label style={{ display: "block", fontSize: 12, color: "#666" }}>
            Ignore specific emails (comma separated)
            <input
              value={ignoreEmails}
              onChange={(e) => setIgnoreEmails(e.target.value)}
              placeholder="team@smithandberg.com, jordan@smithandberg.com"
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
            Run Gmail sync
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
      </div>
    </div>
  );
}