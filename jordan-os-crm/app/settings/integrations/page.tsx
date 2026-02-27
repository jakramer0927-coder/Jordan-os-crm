"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";

type GmailSyncResult = {
  imported: number;
  skipped: number;
  unmatched: number;
  autoCreated?: number;

  messagesFetched?: number;
  messagesParsed?: number;
  matchedRecipients?: number;
  uniqueRecipientsFound?: number;

  topUnmatchedRecipients?: Array<{ email: string; count: number }>;

  usedQuery?: string;
  requireLabels?: boolean;
  maxMessages?: number;
  days?: number;

  autoCreate?: boolean;
  autoMinSeen?: number;
  autoMinConfidence?: number;
  allowClientLeadAutoCreate?: boolean;

  error?: string;
  details?: any;
};

type SheetImportResult = {
  scanned?: number;
  imported?: number;
  updated?: number;
  skipped?: number;
  agentsSkipped?: number;
  allowedAgents?: number;
  emailsInserted?: number;
  error?: string;
  details?: any;
};

async function safeJson(res: Response) {
  const text = await res.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

export default function IntegrationsPage() {
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);

  const [connected, setConnected] = useState(false);
  const [gmailLabels, setGmailLabels] = useState("Jordan OS");
  const [sheetUrl, setSheetUrl] = useState("");

  // Gmail sync tunables (optional controls)
  const [days, setDays] = useState(365);
  const [max, setMax] = useState(600);
  const [autoCreate, setAutoCreate] = useState(true);
  const [autoMinSeen, setAutoMinSeen] = useState(3);
  const [autoMinConfidence, setAutoMinConfidence] = useState(0.78);

  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [gmailResult, setGmailResult] = useState<GmailSyncResult | null>(null);
  const [sheetResult, setSheetResult] = useState<SheetImportResult | null>(null);

  const top10 = useMemo(() => {
    return (gmailResult?.topUnmatchedRecipients ?? []).slice(0, 10);
  }, [gmailResult]);

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

    if (sErr) setErr(sErr.message);

    if (sData?.gmail_label_names) setGmailLabels(sData.gmail_label_names);
    if (sData?.sheet_url) setSheetUrl(sData.sheet_url);

    setReady(true);
  }

  async function connectGoogle() {
    setErr(null);
    setMsg(null);
    if (!uid) return;

    const res = await fetch(`/api/google/oauth/start?uid=${uid}`);
    const { json, text } = await safeJson(res);

    if (!res.ok) {
      setErr((json as any)?.error || text || "Failed to start OAuth");
      return;
    }

    const url = (json as any)?.url;
    if (!url) {
      setErr("OAuth start did not return a URL.");
      return;
    }

    window.location.href = url;
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
    setGmailResult(null);
    if (!uid) return;

    const qs = new URLSearchParams({
      uid,
      days: String(days),
      max: String(max),
      autoCreate: autoCreate ? "1" : "0",
      autoMinSeen: String(autoMinSeen),
      autoMinConfidence: String(autoMinConfidence),
    });

    const res = await fetch(`/api/gmail/sync?${qs.toString()}`);
    const { json, text } = await safeJson(res);

    if (!res.ok) {
      const j = (json as any) || {};
      setErr(j?.error ? `Sync failed (status ${res.status}): ${j.error}` : `Sync failed (status ${res.status}).`);
      if (j?.details) setErr((prev) => `${prev}\n\n${JSON.stringify(j.details, null, 2)}`);
      else if (text) setErr((prev) => `${prev}\n\n${text}`);
      return;
    }

    setGmailResult(json as GmailSyncResult);

    const j = json as GmailSyncResult;
    setMsg(
      `Gmail sync complete. Imported: ${j.imported}, Skipped: ${j.skipped}, Unmatched: ${j.unmatched}` +
        (typeof j.autoCreated === "number" ? `, Auto-created: ${j.autoCreated}` : "")
    );
  }

  async function importSheet() {
    setErr(null);
    setMsg(null);
    setSheetResult(null);
    if (!uid) return;

    const res = await fetch(`/api/sheets/import?uid=${uid}`);
    const { json, text } = await safeJson(res);

    if (!res.ok) {
      const j = (json as any) || {};
      setErr(j?.error ? `Sheet import failed (status ${res.status}): ${j.error}` : `Sheet import failed (status ${res.status}).`);
      if (j?.details) setErr((prev) => `${prev}\n\n${JSON.stringify(j.details, null, 2)}`);
      else if (text) setErr((prev) => `${prev}\n\n${text}`);
      return;
    }

    setSheetResult(json as SheetImportResult);
    const j = json as SheetImportResult;
    setMsg(
      `Sheet import complete. scanned=${j.scanned ?? "?"} imported=${j.imported ?? "?"} updated=${j.updated ?? "?"} skipped=${j.skipped ?? "?"}`
    );
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) return <div style={{ padding: 40 }}>Loading…</div>;

  return (
    <div style={{ padding: 40, maxWidth: 950 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 900 }}>Integrations</h1>
          <div style={{ color: "#666", marginTop: 8 }}>
            Google connection:{" "}
            <strong style={{ color: connected ? "green" : "crimson" }}>{connected ? "Connected" : "Not connected"}</strong>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <a
            href="/morning"
            style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", textDecoration: "none", color: "#111" }}
          >
            Morning
          </a>
          <a
            href="/unmatched"
            style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", textDecoration: "none", color: "#111" }}
          >
            Unmatched
          </a>
          <a
            href="/contacts"
            style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", textDecoration: "none", color: "#111" }}
          >
            Contacts
          </a>
        </div>
      </div>

      {(err || msg) && (
        <div style={{ marginTop: 14, color: err ? "crimson" : "green", fontWeight: 800, whiteSpace: "pre-wrap" }}>
          {err || msg}
        </div>
      )}

      <div style={{ marginTop: 18, border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
        <div style={{ fontWeight: 900 }}>1) Connect Google</div>
        <div style={{ color: "#666", marginTop: 6 }}>
          One connection powers Gmail + Calendar + Sheets. (We’ll use label-based Gmail sync if you want it.)
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
              style={{ display: "block", width: "100%", padding: 10, marginTop: 6, borderRadius: 10, border: "1px solid #ddd" }}
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
              style={{ display: "block", width: "100%", padding: 10, marginTop: 6, borderRadius: 10, border: "1px solid #ddd" }}
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
        <div style={{ fontWeight: 900 }}>3) Gmail sync</div>

        <div style={{ color: "#666", marginTop: 6 }}>
          Imports outbound emails as touches when the recipient matches <code>contacts.email</code> or <code>contact_emails.email</code>.{" "}
          Also populates <code>unmatched_recipients</code> and can auto-create “unreviewed” contacts for high-confidence Agents/Vendors.
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ fontSize: 12, color: "#666" }}>
            Days back
            <input
              type="number"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              style={{ display: "block", padding: 10, marginTop: 6, width: 120, borderRadius: 10, border: "1px solid #ddd" }}
            />
          </label>

          <label style={{ fontSize: 12, color: "#666" }}>
            Max messages
            <input
              type="number"
              value={max}
              onChange={(e) => setMax(Number(e.target.value))}
              style={{ display: "block", padding: 10, marginTop: 6, width: 140, borderRadius: 10, border: "1px solid #ddd" }}
            />
          </label>

          <label style={{ fontSize: 12, color: "#666", display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={autoCreate}
              onChange={(e) => setAutoCreate(e.target.checked)}
              style={{ transform: "scale(1.1)" }}
            />
            Auto-create unreviewed contacts (Agent/Vendor only)
          </label>

          <label style={{ fontSize: 12, color: "#666" }}>
            Auto min seen
            <input
              type="number"
              value={autoMinSeen}
              onChange={(e) => setAutoMinSeen(Number(e.target.value))}
              style={{ display: "block", padding: 10, marginTop: 6, width: 140, borderRadius: 10, border: "1px solid #ddd" }}
            />
          </label>

          <label style={{ fontSize: 12, color: "#666" }}>
            Auto min confidence
            <input
              type="number"
              step="0.01"
              value={autoMinConfidence}
              onChange={(e) => setAutoMinConfidence(Number(e.target.value))}
              style={{ display: "block", padding: 10, marginTop: 6, width: 170, borderRadius: 10, border: "1px solid #ddd" }}
            />
          </label>

          <button
            onClick={runGmailSync}
            style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
          >
            Run Gmail sync
          </button>
        </div>

        {gmailResult && (
          <div style={{ marginTop: 14, borderTop: "1px solid #eee", paddingTop: 12 }}>
            <div style={{ fontWeight: 900 }}>Latest Gmail sync results</div>

            <div style={{ marginTop: 8, display: "grid", gap: 6, color: "#333" }}>
              <div>
                Imported: <strong>{gmailResult.imported}</strong> • Skipped: <strong>{gmailResult.skipped}</strong> • Unmatched:{" "}
                <strong>{gmailResult.unmatched}</strong>{" "}
                {typeof gmailResult.autoCreated === "number" ? (
                  <>
                    • Auto-created: <strong>{gmailResult.autoCreated}</strong>
                  </>
                ) : null}
              </div>

              <div style={{ color: "#666", fontSize: 13 }}>
                messagesFetched={gmailResult.messagesFetched ?? "—"} • messagesParsed={gmailResult.messagesParsed ?? "—"} • uniqueRecipientsFound=
                {gmailResult.uniqueRecipientsFound ?? "—"} • matchedRecipients={gmailResult.matchedRecipients ?? "—"}
              </div>

              <div style={{ color: "#666", fontSize: 13 }}>
                days={gmailResult.days ?? days} • maxMessages={gmailResult.maxMessages ?? max} • autoCreate={String(gmailResult.autoCreate ?? autoCreate)}{" "}
                • autoMinSeen={gmailResult.autoMinSeen ?? autoMinSeen} • autoMinConfidence={gmailResult.autoMinConfidence ?? autoMinConfidence}
              </div>

              {gmailResult.usedQuery ? (
                <div style={{ color: "#999", fontSize: 12 }}>
                  Query: <code>{gmailResult.usedQuery}</code>
                </div>
              ) : null}
            </div>

            {top10.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 900 }}>Top unmatched recipients (this run)</div>
                <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                  {top10.map((x) => (
                    <div key={x.email} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                      <span style={{ wordBreak: "break-word" }}>{x.email}</span>
                      <strong>{x.count}</strong>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 10 }}>
                  <a href="/unmatched">Review / link / ignore in /unmatched →</a>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ marginTop: 14, border: "1px solid #e5e5e5", borderRadius: 14, padding: 14 }}>
        <div style={{ fontWeight: 900 }}>4) Master Sheet import (one-time)</div>
        <div style={{ color: "#666", marginTop: 6 }}>
          Imports your Jordan OS master Google Sheet into contacts/touch logic.
        </div>
        <button
          onClick={importSheet}
          style={{ marginTop: 10, padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
        >
          Import Master Sheet
        </button>

        {sheetResult && (
          <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
            <div style={{ fontWeight: 900 }}>Latest Sheet import results</div>
            <div style={{ marginTop: 8, color: "#333" }}>
              scanned=<strong>{sheetResult.scanned ?? "—"}</strong> • imported=<strong>{sheetResult.imported ?? "—"}</strong> • updated=
              <strong>{sheetResult.updated ?? "—"}</strong> • skipped=<strong>{sheetResult.skipped ?? "—"}</strong>
            </div>
            <div style={{ marginTop: 6, color: "#666", fontSize: 13 }}>
              agentsSkipped=<strong>{sheetResult.agentsSkipped ?? "—"}</strong> • allowedAgents=<strong>{sheetResult.allowedAgents ?? "—"}</strong>
              {typeof sheetResult.emailsInserted === "number" ? (
                <>
                  {" "}
                  • emailsInserted=<strong>{sheetResult.emailsInserted}</strong>
                </>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 18, color: "#999", fontSize: 12 }}>
        Tip: If Gmail sync shows lots of unmatched, go to <a href="/unmatched">/unmatched</a> to triage and link emails to existing contacts.
      </div>
    </div>
  );
}