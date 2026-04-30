"use client";

import { useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const supabase = createSupabaseBrowserClient();

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
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const headerIdx = lines.findIndex(l => /first.?name/i.test(l));
  if (headerIdx === -1) return [];

  const headers = parseCSVLine(lines[headerIdx]).map(h => h.toLowerCase().replace(/[^a-z]/g, ""));
  const get = (cols: string[], keyword: string) => {
    const idx = headers.findIndex(h => h.includes(keyword));
    return idx >= 0 ? (cols[idx] ?? "").replace(/^"|"$/g, "").trim() : "";
  };

  const rows: LinkedInRow[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 2) continue;
    const first = get(cols, "first");
    const last = get(cols, "last");
    if (!first && !last) continue;
    rows.push({
      first_name: first,
      last_name: last,
      email: get(cols, "email"),
      company: get(cols, "company"),
      position: get(cols, "position"),
      connected_on: get(cols, "connected"),
    });
  }
  return rows;
}

function buildApplyLabel(matched: number, newCount: number): string {
  const parts: string[] = [];
  if (matched > 0) parts.push(`Tag ${matched} matched`);
  if (newCount > 0) parts.push(`Add ${newCount} new`);
  return parts.length > 0 ? parts.join(" + ") : "Apply";
}

export default function LinkedInImportPage() {
  const [ready, setReady] = useState(false);
  const [rows, setRows] = useState<LinkedInRow[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<AppliedResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [selectedUnmatched, setSelectedUnmatched] = useState<Set<number>>(new Set());
  const [newCategory, setNewCategory] = useState("Agent");
  const [newTier, setNewTier] = useState("B");

  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { window.location.href = "/login"; return; }
      setReady(true);
    });
  }, []);

  function handleFile(file: File) {
    setError(null);
    setPreview(null);
    setApplied(null);
    setSelectedUnmatched(new Set());
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const parsed = parseLinkedInCSV(text);
      if (parsed.length === 0) {
        setError("Couldn't parse CSV. Make sure you uploaded the LinkedIn Connections export (Connections.csv).");
        return;
      }
      setRows(parsed);
    };
    reader.readAsText(file);
  }

  async function runPreview() {
    if (rows.length === 0) return;
    setLoading(true);
    setError(null);
    setSelectedUnmatched(new Set());
    try {
      const res = await fetch("/api/linkedin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, apply: false }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? "Preview failed"); return; }
      setPreview(j as PreviewResult);
    } catch (e: any) {
      setError(e?.message ?? "Preview failed");
    } finally {
      setLoading(false);
    }
  }

  async function applyImport() {
    if (!preview || rows.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      const selectedItems = Array.from(selectedUnmatched).map(i => ({
        ...preview.unmatchedContacts[i]!,
        category: newCategory,
        tier: newTier,
      }));

      const res = await fetch("/api/linkedin/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, apply: true, selectedToCreate: selectedItems }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? "Apply failed"); return; }
      setApplied({ tagged: j.applied, created: j.created ?? 0 });
      setPreview(null);
      setRows([]);
      setSelectedUnmatched(new Set());
    } catch (e: any) {
      setError(e?.message ?? "Apply failed");
    } finally {
      setApplying(false);
    }
  }

  function toggleUnmatched(i: number) {
    const s = new Set(selectedUnmatched);
    if (s.has(i)) s.delete(i);
    else s.add(i);
    setSelectedUnmatched(s);
  }

  function toggleSelectAll(total: number) {
    if (selectedUnmatched.size === total) {
      setSelectedUnmatched(new Set());
    } else {
      setSelectedUnmatched(new Set(Array.from({ length: total }, (_, i) => i)));
    }
  }

  if (!ready) return <div className="page">Loading…</div>;

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="h1">LinkedIn Import</h1>
          <div className="muted" style={{ marginTop: 4 }}>
            Match your LinkedIn connections to CRM contacts and tag them for scoring.
          </div>
        </div>
        <div className="row">
          <a className="btn" href="/contacts">Contacts</a>
          <a className="btn" href="/morning">Morning</a>
        </div>
      </div>

      {/* Instructions */}
      <div className="card cardPad" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>How to export from LinkedIn</div>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.8, color: "rgba(18,18,18,.7)" }}>
          <li>Go to LinkedIn → Me → Settings &amp; Privacy</li>
          <li>Data Privacy → Get a copy of your data</li>
          <li>Select <strong>Connections</strong> and request archive</li>
          <li>Download the zip, extract, and upload <strong>Connections.csv</strong> below</li>
        </ol>
      </div>

      {error && (
        <div className="card cardPad" style={{ borderColor: "rgba(200,0,0,.2)", background: "rgba(200,0,0,.03)", marginBottom: 12 }}>
          <div style={{ color: "#8a0000", fontWeight: 700, fontSize: 13 }}>{error}</div>
        </div>
      )}

      {applied !== null && (
        <div className="card cardPad" style={{ borderColor: "rgba(11,107,42,.2)", background: "rgba(11,107,42,.04)", marginBottom: 12 }}>
          <div style={{ fontWeight: 900, color: "#0b6b2a", fontSize: 15 }}>
            {[
              applied.tagged > 0 && `${applied.tagged} contact${applied.tagged !== 1 ? "s" : ""} tagged as LinkedIn connections`,
              applied.created > 0 && `${applied.created} new contact${applied.created !== 1 ? "s" : ""} added`,
            ].filter(Boolean).map((msg, i) => <div key={i}>✓ {msg}</div>)}
          </div>
          <div className="muted small" style={{ marginTop: 4 }}>
            Tagged contacts get a scoring boost in your Morning recommendations.
          </div>
          <div className="row" style={{ marginTop: 12, gap: 8 }}>
            <a className="btn btnPrimary" href="/morning">Go to Morning →</a>
            <button className="btn" onClick={() => { setApplied(null); setError(null); }}>Import another file</button>
          </div>
        </div>
      )}

      {/* Upload area */}
      {applied === null && (
        <>
          <div
            className="card cardPad"
            style={{ marginBottom: 12, cursor: "pointer", textAlign: "center", padding: "32px 24px" }}
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file) handleFile(file);
            }}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".csv"
              style={{ display: "none" }}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
            {rows.length > 0 ? (
              <>
                <div style={{ fontWeight: 900, fontSize: 16, color: "#0b6b2a" }}>✓ {rows.length} connections loaded</div>
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

          {rows.length > 0 && !preview && (
            <button
              className="btn btnPrimary"
              style={{ width: "100%", justifyContent: "center", fontSize: 15, padding: "12px" }}
              onClick={runPreview}
              disabled={loading}
            >
              {loading ? "Matching connections…" : `Match ${rows.length} connections against CRM`}
            </button>
          )}
        </>
      )}

      {/* Preview results */}
      {preview && (
        <div className="stack">
          {/* Summary + apply */}
          <div className="card cardPad">
            <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 12 }}>Match results</div>
            <div className="row" style={{ gap: 24, flexWrap: "wrap", marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 28, fontWeight: 900, color: "#0b6b2a" }}>{preview.matched}</div>
                <div className="muted small">matched in CRM</div>
              </div>
              <div>
                <div style={{ fontSize: 28, fontWeight: 900, color: "rgba(18,18,18,.4)" }}>{preview.unmatched}</div>
                <div className="muted small">not in CRM</div>
              </div>
              <div>
                <div style={{ fontSize: 28, fontWeight: 900 }}>{preview.total}</div>
                <div className="muted small">total connections</div>
              </div>
            </div>
            <div className="muted small" style={{ marginBottom: 16 }}>
              Matched contacts will be tagged with their LinkedIn connection date, improving their morning score.
              Select unmatched connections below to add them as new contacts.
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn btnPrimary"
                style={{ fontSize: 14, padding: "10px 20px" }}
                onClick={applyImport}
                disabled={applying || (preview.matched === 0 && selectedUnmatched.size === 0)}
              >
                {applying ? "Applying…" : buildApplyLabel(preview.matched, selectedUnmatched.size)}
              </button>
              <button className="btn" onClick={() => { setPreview(null); setRows([]); setSelectedUnmatched(new Set()); }}>
                Cancel
              </button>
            </div>
          </div>

          {/* Matched contacts */}
          {preview.matchedContacts.length > 0 && (
            <div>
              <div className="sectionTitle" style={{ marginBottom: 8 }}>
                Matched contacts ({preview.matchedContacts.length}{preview.matched > 200 ? "+" : ""})
              </div>
              <div className="stack">
                {preview.matchedContacts.map((m, i) => (
                  <div key={i} className="card cardPad" style={{ padding: "8px 12px" }}>
                    <div className="rowBetween">
                      <div>
                        <span style={{ fontWeight: 800, fontSize: 14 }}>{m.display_name}</span>
                        {m.display_name !== m.linkedin_name && (
                          <span className="muted small" style={{ marginLeft: 6 }}>LinkedIn: {m.linkedin_name}</span>
                        )}
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        <span className="badge" style={{ fontSize: 11 }}>
                          {m.match_type === "email" ? "Email match" : "Name match"}
                        </span>
                        {m.connected_on && (
                          <span className="badge" style={{ fontSize: 11 }}>
                            Connected {m.connected_on}
                          </span>
                        )}
                      </div>
                    </div>
                    {(m.company || m.position) && (
                      <div className="muted small" style={{ marginTop: 2 }}>
                        {[m.position, m.company].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Unmatched contacts — selectable */}
          {preview.unmatchedContacts.length > 0 && (
            <div>
              <div className="rowBetween" style={{ marginBottom: 8 }}>
                <div className="sectionTitle">
                  Not in CRM ({preview.unmatched}{preview.unmatched > 100 ? ", showing first 100" : ""})
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer", userSelect: "none" }}>
                  <input
                    type="checkbox"
                    checked={selectedUnmatched.size === preview.unmatchedContacts.length && preview.unmatchedContacts.length > 0}
                    onChange={() => toggleSelectAll(preview.unmatchedContacts.length)}
                  />
                  Select all
                </label>
              </div>

              <div className="stack">
                {preview.unmatchedContacts.map((u, i) => (
                  <label key={i} className="card cardPad" style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", userSelect: "none" }}>
                    <input
                      type="checkbox"
                      checked={selectedUnmatched.has(i)}
                      onChange={() => toggleUnmatched(i)}
                      style={{ flexShrink: 0 }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{u.linkedin_name}</div>
                      {(u.email || u.company || u.position) && (
                        <div className="muted small" style={{ marginTop: 2, fontSize: 12 }}>
                          {[u.position, u.company, u.email].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  </label>
                ))}
              </div>

              {/* Category/tier picker — only shown when something is selected */}
              {selectedUnmatched.size > 0 && (
                <div className="card cardPad" style={{ marginTop: 8 }}>
                  <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 10 }}>
                    Add {selectedUnmatched.size} selected as new contacts
                  </div>
                  <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                    <div className="field">
                      <div className="label">Category</div>
                      <select className="select" value={newCategory} onChange={e => setNewCategory(e.target.value)}>
                        <option>Agent</option>
                        <option>Client</option>
                        <option>Sphere</option>
                        <option>Developer</option>
                        <option>Vendor</option>
                        <option>Other</option>
                      </select>
                    </div>
                    <div className="field">
                      <div className="label">Tier</div>
                      <select className="select" value={newTier} onChange={e => setNewTier(e.target.value)}>
                        <option value="A">A</option>
                        <option value="B">B</option>
                        <option value="C">C</option>
                        <option value="D">D</option>
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
  );
}
