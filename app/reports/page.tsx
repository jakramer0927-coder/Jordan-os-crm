"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const supabase = createSupabaseBrowserClient();

type Report = {
  id: string;
  period_label: string;
  period_start: string;
  period_end: string;
  content: string;
  created_at: string;
  data_snapshot: any;
};

// Simple markdown → React renderer (no library needed)
function renderMarkdown(text: string) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];
  let key = 0;

  function flushList() {
    if (listItems.length === 0) return;
    elements.push(
      <ul key={key++} style={{ margin: "6px 0 14px 0", paddingLeft: 20, lineHeight: 1.7 }}>
        {listItems.map((item, i) => (
          <li key={i} style={{ fontSize: 14, color: "var(--ink)" }}
            dangerouslySetInnerHTML={{ __html: inlineFormat(item) }}
          />
        ))}
      </ul>
    );
    listItems = [];
  }

  function inlineFormat(s: string): string {
    return s
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>");
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("## ")) {
      flushList();
      const text = trimmed.slice(3);
      elements.push(
        <h2 key={key++} style={{ fontSize: 17, fontWeight: 900, marginTop: 24, marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid rgba(0,0,0,.08)" }}>
          {text}
        </h2>
      );
      continue;
    }

    if (trimmed.startsWith("### ")) {
      flushList();
      elements.push(
        <h3 key={key++} style={{ fontSize: 15, fontWeight: 800, marginTop: 16, marginBottom: 6 }}>
          {trimmed.slice(4)}
        </h3>
      );
      continue;
    }

    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      listItems.push(trimmed.slice(2));
      continue;
    }

    // Numbered list
    const numMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
    if (numMatch) {
      listItems.push(numMatch[2]);
      continue;
    }

    flushList();

    if (trimmed === "") {
      elements.push(<div key={key++} style={{ height: 6 }} />);
      continue;
    }

    elements.push(
      <p key={key++} style={{ fontSize: 14, lineHeight: 1.7, margin: "4px 0", color: "var(--ink)" }}
        dangerouslySetInnerHTML={{ __html: inlineFormat(trimmed) }}
      />
    );
  }

  flushList();
  return elements;
}

export default function ReportsPage() {
  const [ready, setReady] = useState(false);
  const [reports, setReports] = useState<Report[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { window.location.href = "/login"; return; }
      loadReports();
      setReady(true);
    });
  }, []);

  async function loadReports() {
    const { data } = await supabase
      .from("reports")
      .select("id, period_label, period_start, period_end, content, created_at, data_snapshot")
      .order("created_at", { ascending: false })
      .limit(12);
    if (data && data.length > 0) {
      setReports(data as Report[]);
      setActiveId(data[0].id);
    }
  }

  async function generateReport() {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/reports/generate", { method: "POST" });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? "Generation failed"); return; }
      await loadReports();
    } catch (e: any) {
      setError(e?.message ?? "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  if (!ready) return <div className="page">Loading…</div>;

  const activeReport = reports.find((r) => r.id === activeId) ?? null;
  const snap = activeReport?.data_snapshot;

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="h1">Intelligence Reports</h1>
          <div className="muted" style={{ marginTop: 4 }}>
            Monthly Claude-generated analysis of your CRM activity, referral network, and pipeline.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <a className="btn" href="/insights">Insights</a>
          <a className="btn" href="/morning">Morning</a>
          <button
            className="btn btnPrimary"
            onClick={generateReport}
            disabled={generating}
            style={{ minWidth: 140 }}
          >
            {generating ? "Generating…" : "Generate report"}
          </button>
        </div>
      </div>

      {error && (
        <div className="card cardPad" style={{ borderColor: "rgba(200,0,0,.2)", background: "rgba(200,0,0,.03)", marginBottom: 12 }}>
          <div style={{ color: "#8a0000", fontWeight: 700, fontSize: 13 }}>{error}</div>
        </div>
      )}

      {generating && (
        <div className="card cardPad" style={{ borderColor: "rgba(11,107,42,.2)", background: "rgba(11,107,42,.03)", marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Analyzing your CRM data…</div>
          <div className="muted small">Claude is reviewing your touch activity, referral network, and pipeline. This takes about 10 seconds.</div>
        </div>
      )}

      {reports.length === 0 && !generating ? (
        <div className="card cardPad" style={{ textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>📊</div>
          <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 8 }}>No reports yet</div>
          <div className="muted" style={{ marginBottom: 20, maxWidth: 400, margin: "0 auto 20px" }}>
            Generate your first report to get a Claude-written analysis of your CRM activity, referral network health, and pipeline — with specific contacts to prioritize this month.
          </div>
          <button className="btn btnPrimary" onClick={generateReport} disabled={generating} style={{ fontSize: 15, padding: "12px 24px" }}>
            Generate first report
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: reports.length > 1 ? "200px 1fr" : "1fr", gap: 16, alignItems: "start" }}>

          {/* Report history sidebar */}
          {reports.length > 1 && (
            <div className="stack" style={{ gap: 4 }}>
              <div className="sectionTitle" style={{ marginBottom: 8 }}>History</div>
              {reports.map((r) => (
                <button
                  key={r.id}
                  className="btn"
                  style={{
                    width: "100%",
                    justifyContent: "flex-start",
                    textAlign: "left",
                    fontSize: 13,
                    fontWeight: r.id === activeId ? 900 : 400,
                    background: r.id === activeId ? "var(--ink)" : undefined,
                    color: r.id === activeId ? "var(--paper)" : undefined,
                    padding: "8px 12px",
                  }}
                  onClick={() => setActiveId(r.id)}
                >
                  <div>{r.period_label}</div>
                  <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
                    {new Date(r.created_at).toLocaleDateString()}
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Report content */}
          {activeReport && (
            <div>
              {/* Snapshot stats bar */}
              {snap && (
                <div className="card cardPad" style={{ marginBottom: 12 }}>
                  <div className="rowBetween" style={{ flexWrap: "wrap", gap: 20 }}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 900 }}>{snap.touches?.this_period ?? "—"}</div>
                      <div className="muted small">touches this period</div>
                      {snap.touches?.delta !== undefined && (
                        <div style={{ fontSize: 11, color: snap.touches.delta >= 0 ? "#0b6b2a" : "#8a0000", fontWeight: 700 }}>
                          {snap.touches.delta >= 0 ? "+" : ""}{snap.touches.delta} vs prior
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 900 }}>{snap.contacts?.total ?? "—"}</div>
                      <div className="muted small">active contacts</div>
                      {snap.contacts?.never_touched > 0 && (
                        <div style={{ fontSize: 11, color: "#8a0000", fontWeight: 700 }}>
                          {snap.contacts.never_touched} never touched
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 900 }}>{snap.referrals?.asks_last_90d ?? "—"}</div>
                      <div className="muted small">referral asks (90d)</div>
                      {snap.referrals?.conversion_rate !== null && snap.referrals?.conversion_rate !== undefined && (
                        <div style={{ fontSize: 11, color: snap.referrals.conversion_rate >= 15 ? "#0b6b2a" : "rgba(18,18,18,.5)", fontWeight: 700 }}>
                          {snap.referrals.conversion_rate}% converted
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 900 }}>{snap.pipeline?.active_deals ?? "—"}</div>
                      <div className="muted small">active deals</div>
                      {snap.pipeline?.active_pipeline_value > 0 && (
                        <div style={{ fontSize: 11, color: "rgba(18,18,18,.5)", fontWeight: 700 }}>
                          ${Math.round(snap.pipeline.active_pipeline_value / 1000000 * 10) / 10}M value
                        </div>
                      )}
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 900 }}>
                        {snap.referral_network?.overdue_top_sources ?? "—"}
                      </div>
                      <div className="muted small">overdue top sources</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Report body */}
              <div className="card cardPad" style={{ lineHeight: 1.6 }}>
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
                  <span className="muted small">
                    Generated {new Date(activeReport.created_at).toLocaleString()}
                  </span>
                </div>
                {renderMarkdown(activeReport.content)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
