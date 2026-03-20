"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

export default function ImportsPage() {
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function runImport() {
    setErr(null);
    setMsg(null);
    setLoading(true);

    const { data } = await supabase.auth.getSession();
    const uid = data.session?.user?.id;

    if (!uid) {
      window.location.href = "/login";
      return;
    }

    if (!file) {
      setErr("Choose a CSV file first.");
      setLoading(false);
      return;
    }

    try {
      const fd = new FormData();
      fd.append("file", file);

      const res = await fetch(`/api/import/compass?uid=${encodeURIComponent(uid)}`, {
        method: "POST",
        body: fd,
      });

      // Always read as text first
      const rawText = await res.text();

      let parsed: any = null;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = null;
      }

      setLoading(false);

      if (!res.ok) {
        const baseError = parsed?.error || rawText || `Import failed (status ${res.status})`;

        const details = parsed?.details ? `\n\nDetails:\n${parsed.details}` : "";

        setErr(baseError + details);
        return;
      }

      if (!parsed) {
        setErr("Import returned unexpected response:\n" + rawText);
        return;
      }

      setMsg(
        `Done.\n\n` +
        `scanned=${parsed.scanned}\n` +
        `imported=${parsed.imported}\n` +
        `updated=${parsed.updated}\n` +
        `skipped=${parsed.skipped}\n` +
        `agentsSkipped=${parsed.agentsSkipped}\n` +
        `allowedAgents=${parsed.allowedAgents}` +
        (parsed.agentWarning ? `\n\nWarning:\n${parsed.agentWarning}` : ""),
      );
    } catch (e: any) {
      setLoading(false);
      setErr("Unexpected client error:\n" + String(e?.message || e));
    }
  }

  return (
    <div style={{ padding: 40, maxWidth: 900 }}>
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 900 }}>Imports</h1>

      <div style={{ marginTop: 8, color: "#666" }}>
        Compass CSV import:
        <br />
        • Imports all non-agent groups
        <br />
        • Imports ONLY agents listed in your Master Sheet
        <br />• Appends Compass notes (does not overwrite)
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

      <div
        style={{
          marginTop: 18,
          border: "1px solid #e5e5e5",
          borderRadius: 14,
          padding: 14,
        }}
      >
        <div style={{ fontWeight: 900 }}>Compass CSV</div>

        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          style={{ marginTop: 10 }}
        />

        <div style={{ marginTop: 12 }}>
          <button
            onClick={runImport}
            disabled={loading}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: "pointer",
              fontWeight: 900,
            }}
          >
            {loading ? "Importing…" : "Run import"}
          </button>
        </div>

        <div style={{ marginTop: 10, color: "#666", fontSize: 12 }}>
          Notes behavior: Compass notes are appended (not overwritten).
          <br />
          Tier is not set from Compass import.
        </div>
      </div>
    </div>
  );
}
