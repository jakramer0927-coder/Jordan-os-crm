"use client";

import { useEffect, useRef, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

// Columns we support in the CSV
type ContactRow = {
  display_name: string;
  category: string;
  tier: string;
  client_type: string;
  email: string;
  phone: string;
  company: string;
  notes: string;
};

type ParsedRow = ContactRow & { _line: number; _error?: string };

type ImportResult = {
  inserted: number;
  skipped: number;
  errors: Array<{ line: number; name: string; error: string }>;
};

const CATEGORY_OPTIONS = ["client", "agent", "developer", "vendor", "sphere", "other"];
const TIER_OPTIONS = ["", "A", "B", "C"];
const CLIENT_TYPE_OPTIONS = ["", "buyer", "seller", "both", "past_client", "investor"];

// Map common column header aliases to our field names
const ALIASES: Record<string, keyof ContactRow> = {
  name: "display_name",
  full_name: "display_name",
  fullname: "display_name",
  contact: "display_name",
  contact_name: "display_name",
  display_name: "display_name",
  cat: "category",
  category: "category",
  type: "category",
  tier: "tier",
  client_type: "client_type",
  clienttype: "client_type",
  email: "email",
  email_address: "email",
  emailaddress: "email",
  phone: "phone",
  phone_number: "phone",
  mobile: "phone",
  cell: "phone",
  company: "company",
  firm: "company",
  brokerage: "company",
  notes: "notes",
  note: "notes",
  comments: "notes",
};

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  function splitLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
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

  const headers = splitLine(lines[0]!);
  const rows = lines.slice(1).map(splitLine);
  return { headers, rows };
}

function mapHeaders(headers: string[]): Array<keyof ContactRow | null> {
  return headers.map((h) => {
    const key = h.toLowerCase().trim().replace(/\s+/g, "_");
    return ALIASES[key] ?? null;
  });
}

function normalizeCategory(v: string): string {
  const s = (v || "").toLowerCase().trim();
  if (CATEGORY_OPTIONS.includes(s)) return s;
  // common aliases
  if (s === "realtor" || s === "broker" || s === "buyers agent" || s === "listing agent") return "agent";
  if (s === "dev" || s === "builder") return "developer";
  if (s === "past client" || s === "past_client") return "client";
  if (s === "friend" || s === "family" || s === "referral") return "sphere";
  return s || "other";
}

function normalizeTier(v: string): string {
  const s = (v || "").toUpperCase().trim();
  if (["A", "B", "C"].includes(s)) return s;
  return "";
}

function normalizeClientType(v: string): string {
  const s = (v || "").toLowerCase().trim().replace(/\s+/g, "_");
  if (CLIENT_TYPE_OPTIONS.includes(s)) return s;
  if (s === "buy" || s === "buying") return "buyer";
  if (s === "sell" || s === "selling") return "seller";
  if (s === "past") return "past_client";
  return s || "";
}

function buildRows(headers: string[], rows: string[][]): ParsedRow[] {
  const mapping = mapHeaders(headers);

  return rows.map((cells, i) => {
    const row: Partial<ContactRow> = {};
    cells.forEach((val, ci) => {
      const field = mapping[ci];
      if (field) row[field] = val.trim();
    });

    const display_name = (row.display_name || "").trim();
    const error = !display_name ? "Missing name" : undefined;

    return {
      _line: i + 2,
      _error: error,
      display_name,
      category: normalizeCategory(row.category || ""),
      tier: normalizeTier(row.tier || ""),
      client_type: normalizeClientType(row.client_type || ""),
      email: (row.email || "").trim(),
      phone: (row.phone || "").trim(),
      company: (row.company || "").trim(),
      notes: (row.notes || "").trim(),
    };
  });
}

export default function ImportPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);

  const [rawText, setRawText] = useState("");
  const [parsed, setParsed] = useState<ParsedRow[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);

  // Editable rows (user can fix before importing)
  const [rows, setRows] = useState<ParsedRow[]>([]);

  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session?.user) window.location.href = "/login";
      else setReady(true);
    });
  }, []);

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = (e.target?.result as string) || "";
      setRawText(text);
      processText(text);
    };
    reader.readAsText(file);
  }

  function processText(text: string) {
    setParseError(null);
    setResult(null);
    try {
      const { headers: h, rows: r } = parseCSV(text);
      if (h.length === 0) { setParseError("No columns found — is this a valid CSV?"); return; }
      setHeaders(h);
      const built = buildRows(h, r);
      setParsed(built);
      setRows(built);
    } catch (e: any) {
      setParseError(e?.message || "Failed to parse CSV");
    }
  }

  function updateRow(idx: number, field: keyof ContactRow, value: string) {
    setRows((prev) => {
      const next = [...prev];
      const updated = { ...next[idx]!, [field]: value };
      // Clear error if name is now present
      if (field === "display_name" && value.trim()) updated._error = undefined;
      else if (field === "display_name" && !value.trim()) updated._error = "Missing name";
      next[idx] = updated;
      return next;
    });
  }

  function removeRow(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }

  async function doImport() {
    const valid = rows.filter((r) => !r._error && r.display_name.trim());
    if (valid.length === 0) return;

    setImporting(true);
    setResult(null);

    const res = await fetch("/api/contacts/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: valid }),
    });

    const j = await res.json();
    setImporting(false);

    if (!res.ok) {
      setParseError(j?.error || "Import failed");
      return;
    }

    setResult(j as ImportResult);
    if ((j as ImportResult).inserted > 0) {
      // Clear the parsed state so they can start fresh
      setRows([]);
      setParsed([]);
      setRawText("");
    }
  }

  if (!ready) return <div className="page">Loading…</div>;

  const validCount = rows.filter((r) => !r._error && r.display_name.trim()).length;
  const errorCount = rows.filter((r) => !!r._error).length;

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="h1">Import Contacts</h1>
          <div className="muted" style={{ marginTop: 4 }}>
            Upload a CSV with contact info. Required: <strong>name</strong>. Optional: category, tier, email, phone, company, notes.
          </div>
        </div>
        <div className="row">
          <a className="btn" href="/contacts">← Contacts</a>
        </div>
      </div>

      {/* Upload area */}
      {rows.length === 0 && (
        <div className="section">
          <div
            className="card cardPad"
            style={{ textAlign: "center", cursor: "pointer", border: "2px dashed rgba(0,0,0,0.15)" }}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file) handleFile(file);
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 8 }}>📂</div>
            <div style={{ fontWeight: 700 }}>Drop a CSV here or click to browse</div>
            <div className="muted small" style={{ marginTop: 6 }}>
              Accepts .csv files. Headers are auto-detected — see accepted names below.
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
          </div>

          <div className="card cardPad" style={{ marginTop: 12 }}>
            <div className="sectionTitle" style={{ marginBottom: 8, fontSize: 13 }}>Accepted column headers</div>
            <div className="muted small" style={{ lineHeight: 1.8 }}>
              <strong>Name (required):</strong> name, full_name, display_name, contact<br />
              <strong>Category:</strong> category, cat, type → client, agent, developer, vendor, sphere<br />
              <strong>Tier:</strong> tier → A, B, C<br />
              <strong>Client type:</strong> client_type → buyer, seller, both, investor, past_client<br />
              <strong>Email:</strong> email, email_address<br />
              <strong>Phone:</strong> phone, mobile, cell<br />
              <strong>Company:</strong> company, firm, brokerage<br />
              <strong>Notes:</strong> notes, comments
            </div>
          </div>
        </div>
      )}

      {parseError && (
        <div className="alert alertError" style={{ marginTop: 12 }}>{parseError}</div>
      )}

      {result && (
        <div className="card cardPad" style={{ marginTop: 12, borderColor: "rgba(11,107,42,0.3)" }}>
          <div style={{ fontWeight: 900, color: "#0b6b2a", fontSize: 16 }}>
            Import complete — {result.inserted} contacts added
          </div>
          {result.skipped > 0 && (
            <div className="muted small" style={{ marginTop: 4 }}>{result.skipped} skipped (duplicates or errors)</div>
          )}
          {result.errors.length > 0 && (
            <div className="muted small" style={{ marginTop: 8 }}>
              {result.errors.map((e) => (
                <div key={e.line}>Line {e.line} ({e.name}): {e.error}</div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <a className="btn btnPrimary" href="/contacts">View contacts →</a>
          </div>
        </div>
      )}

      {/* Preview + edit table */}
      {rows.length > 0 && (
        <div className="section" style={{ marginTop: 12 }}>
          <div className="rowBetween" style={{ marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
            <div>
              <div className="sectionTitle">Preview — {rows.length} rows</div>
              <div className="muted small" style={{ marginTop: 2 }}>
                {validCount} ready to import{errorCount > 0 ? ` • ${errorCount} with errors (fix or remove)` : ""}
              </div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn" onClick={() => { setRows([]); setParsed([]); setRawText(""); setResult(null); }}>
                Clear
              </button>
              <button
                className="btn btnPrimary"
                onClick={doImport}
                disabled={importing || validCount === 0}
              >
                {importing ? "Importing…" : `Import ${validCount} contacts`}
              </button>
            </div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid rgba(0,0,0,0.1)" }}>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 700 }}>Name *</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 700 }}>Category</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 700 }}>Tier</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 700 }}>Client type</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 700 }}>Email</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 700 }}>Phone</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 700 }}>Company</th>
                  <th style={{ textAlign: "left", padding: "6px 8px", fontWeight: 700 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => (
                  <tr
                    key={idx}
                    style={{
                      borderBottom: "1px solid rgba(0,0,0,0.07)",
                      background: row._error ? "rgba(160,0,0,0.04)" : undefined,
                    }}
                  >
                    <td style={{ padding: "4px 8px" }}>
                      <input
                        className="input"
                        style={{ minWidth: 140, border: row._error ? "1px solid rgba(160,0,0,0.4)" : undefined }}
                        value={row.display_name}
                        onChange={(e) => updateRow(idx, "display_name", e.target.value)}
                      />
                      {row._error && <div style={{ color: "#8a0000", fontSize: 11, marginTop: 2 }}>{row._error}</div>}
                    </td>
                    <td style={{ padding: "4px 8px" }}>
                      <select className="select" style={{ minWidth: 100 }} value={row.category} onChange={(e) => updateRow(idx, "category", e.target.value)}>
                        {CATEGORY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "4px 8px" }}>
                      <select className="select" value={row.tier} onChange={(e) => updateRow(idx, "tier", e.target.value)}>
                        {TIER_OPTIONS.map((o) => <option key={o} value={o}>{o || "—"}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "4px 8px" }}>
                      <select className="select" value={row.client_type} onChange={(e) => updateRow(idx, "client_type", e.target.value)}>
                        {CLIENT_TYPE_OPTIONS.map((o) => <option key={o} value={o}>{o || "—"}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: "4px 8px" }}>
                      <input className="input" style={{ minWidth: 160 }} value={row.email} onChange={(e) => updateRow(idx, "email", e.target.value)} placeholder="email" />
                    </td>
                    <td style={{ padding: "4px 8px" }}>
                      <input className="input" style={{ minWidth: 120 }} value={row.phone} onChange={(e) => updateRow(idx, "phone", e.target.value)} placeholder="phone" />
                    </td>
                    <td style={{ padding: "4px 8px" }}>
                      <input className="input" style={{ minWidth: 120 }} value={row.company} onChange={(e) => updateRow(idx, "company", e.target.value)} placeholder="company" />
                    </td>
                    <td style={{ padding: "4px 8px" }}>
                      <button className="btn" style={{ fontSize: 11, padding: "2px 8px" }} onClick={() => removeRow(idx)}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
