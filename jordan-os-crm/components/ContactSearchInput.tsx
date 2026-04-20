"use client";

import { useEffect, useRef, useState } from "react";

interface ContactResult {
  id: string;
  display_name: string;
  category: string;
  tier?: string | null;
}

interface Props {
  selectedId: string;
  selectedName: string;
  onSelect: (id: string, name: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export default function ContactSearchInput({ selectedId, selectedName, onSelect, placeholder = "Search contacts…", autoFocus }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ContactResult[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim() || query.trim().length < 2) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      const res = await fetch(`/api/contacts/search?q=${encodeURIComponent(query.trim())}`);
      const j = await res.json().catch(() => ({}));
      setResults(res.ok ? (j.results ?? []) : []);
    }, 200);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  async function createContact() {
    if (!query.trim()) return;
    setCreating(true);
    setCreateError(null);
    const res = await fetch("/api/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ display_name: query.trim(), category: "sphere" }),
    });
    const j = await res.json().catch(() => ({}));
    setCreating(false);
    if (!res.ok) { setCreateError(j?.error || "Failed to create contact"); return; }
    const newId = j?.id;
    const newName = query.trim();
    if (newId) {
      onSelect(newId, newName);
      setQuery("");
      setResults([]);
    }
  }

  if (selectedId) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <strong>{selectedName}</strong>
        <button className="btn" style={{ fontSize: 11, padding: "1px 8px" }}
          onClick={() => { onSelect("", ""); setQuery(""); }}>
          Change
        </button>
      </div>
    );
  }

  const showDropdown = query.trim().length >= 2 && (results.length > 0 || !creating);

  return (
    <div style={{ position: "relative" }}>
      <input
        className="input"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="new-password"
        data-1p-ignore
      />
      {showDropdown && (
        <div style={{ marginTop: 4, border: "1px solid rgba(0,0,0,.1)", borderRadius: 6, overflow: "hidden", background: "var(--paper, #fff)" }}>
          {results.map(c => (
            <button key={c.id} className="btn" style={{ width: "100%", borderRadius: 0, textAlign: "left", fontSize: 13 }}
              onClick={() => { onSelect(c.id, c.display_name); setQuery(""); setResults([]); }}>
              {c.display_name}
              {c.category && <span className="subtle" style={{ marginLeft: 6 }}>{c.category}{c.tier ? ` · ${c.tier}` : ""}</span>}
            </button>
          ))}
          <button
            className="btn"
            style={{ width: "100%", borderRadius: 0, textAlign: "left", fontSize: 13, borderTop: results.length > 0 ? "1px solid rgba(0,0,0,.07)" : undefined, color: "var(--accent, #1a3f8a)", fontWeight: 700 }}
            onClick={createContact}
            disabled={creating}
          >
            {creating ? "Creating…" : `+ Create "${query.trim()}"`}
          </button>
        </div>
      )}
      {createError && <div style={{ fontSize: 12, color: "#8a0000", marginTop: 4 }}>{createError}</div>}
    </div>
  );
}
