"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const supabase = createSupabaseBrowserClient();

type TContact = {
  id: string;
  display_name: string;
  email: string | null;
  company: string | null;
  notes: string | null;
  category: string;
  tier: string | null;
};

type Suggestion = {
  id: string;
  category: string;
  tier: string;
  reason: string;
};

const CATEGORIES = ["Agent", "Client", "Developer", "Vendor", "Sphere", "Other"] as const;
const TIERS = ["A", "B", "C"] as const;

const CAT_KEYS: Record<string, typeof CATEGORIES[number]> = {
  "1": "Agent", "2": "Client", "3": "Developer", "4": "Vendor", "5": "Sphere", "6": "Other",
};

export default function TriagePage() {
  const [ready, setReady] = useState(false);
  const [contacts, setContacts] = useState<TContact[]>([]);
  const [totalUnclassified, setTotalUnclassified] = useState(0);
  const [idx, setIdx] = useState(0);
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>({});
  const [selectedCat, setSelectedCat] = useState<string>("");
  const [selectedTier, setSelectedTier] = useState<string>("");
  const [classifying, setClassifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const classifyBatchRef = useRef<Set<number>>(new Set());

  async function load() {
    const { data: sd } = await supabase.auth.getSession();
    if (!sd.session?.user) { window.location.href = "/login"; return; }

    const { data, error: err } = await supabase
      .from("contacts")
      .select("id, display_name, email, company, notes, category, tier")
      .is("tier", null)
      .eq("archived", false)
      .order("display_name", { ascending: true })
      .limit(500);

    if (err) { setError(err.message); setReady(true); return; }

    const rows = (data || []) as TContact[];
    setContacts(rows);
    setTotalUnclassified(rows.length);
    setReady(true);

    // Classify first batch
    if (rows.length > 0) classifyBatch(rows, 0);
  }

  async function classifyBatch(all: TContact[], startIdx: number) {
    const batchKey = Math.floor(startIdx / 25);
    if (classifyBatchRef.current.has(batchKey)) return;
    classifyBatchRef.current.add(batchKey);

    const batch = all.slice(startIdx, startIdx + 25);
    if (batch.length === 0) return;

    setClassifying(true);
    try {
      const res = await fetch("/api/contacts/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contacts: batch.map((c) => ({
            id: c.id,
            display_name: c.display_name,
            email: c.email,
            company: c.company,
            notes: c.notes ? c.notes.slice(0, 400) : null,
            category: c.category,
          })),
        }),
      });

      const j = await res.json();
      if (res.ok && Array.isArray(j.suggestions)) {
        setSuggestions((prev) => {
          const next = { ...prev };
          for (const s of j.suggestions as Suggestion[]) next[s.id] = s;
          return next;
        });
      }
    } catch {
      // non-fatal — agent can still classify manually
    } finally {
      setClassifying(false);
    }
  }

  // Pre-fetch next batch when agent gets close
  useEffect(() => {
    if (contacts.length === 0) return;
    const nextBatchStart = Math.floor((idx + 10) / 25) * 25;
    if (nextBatchStart < contacts.length) {
      classifyBatch(contacts, nextBatchStart);
    }
  }, [idx, contacts]);

  // Apply AI suggestion for current contact when it arrives
  const current = contacts[idx] ?? null;
  useEffect(() => {
    if (!current) return;
    const sug = suggestions[current.id];
    if (sug) {
      setSelectedCat(sug.category);
      setSelectedTier(sug.tier);
    } else {
      // Pre-fill from existing category if not "other"
      setSelectedCat(current.category !== "other" ? capitalize(current.category) : "");
      setSelectedTier("");
    }
  }, [current?.id, suggestions]);

  function capitalize(s: string) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  async function saveAndAdvance(cat: string, tier: string) {
    if (!current || saving) return;
    setSaving(true);
    setError(null);

    const { error: err } = await supabase
      .from("contacts")
      .update({ category: cat, tier })
      .eq("id", current.id);

    setSaving(false);
    if (err) { setError(`Save failed: ${err.message}`); return; }

    setSavedCount((n) => n + 1);
    advance();
  }

  function skip() {
    setSkippedCount((n) => n + 1);
    advance();
  }

  function advance() {
    setSelectedCat("");
    setSelectedTier("");
    setIdx((i) => i + 1);
  }

  // Keyboard shortcuts
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (!current || saving) return;
      // Ignore when typing in an input
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;

      const cat = CAT_KEYS[e.key];
      if (cat) { setSelectedCat(cat); return; }

      if (e.key === "a" || e.key === "A") { saveAndAdvance(selectedCat || "Other", "A"); return; }
      if (e.key === "b" || e.key === "B") { saveAndAdvance(selectedCat || "Other", "B"); return; }
      if (e.key === "c" || e.key === "C") { saveAndAdvance(selectedCat || "Other", "C"); return; }
      if (e.key === "s" || e.key === " ") { e.preventDefault(); skip(); return; }
    },
    [current, saving, selectedCat]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  useEffect(() => { load(); }, []);

  if (!ready) return <div className="page">Loading…</div>;

  const done = idx >= contacts.length;
  const progress = totalUnclassified > 0
    ? Math.round(((savedCount + skippedCount) / totalUnclassified) * 100)
    : 100;
  const sug = current ? suggestions[current.id] : null;

  return (
    <div>
      <div className="pageHeader">
        <div>
          <h1 className="h1">Classify Contacts</h1>
          <div className="muted" style={{ marginTop: 4 }}>
            Set category + tier so your Morning page can start coaching you.
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <a className="btn" href="/contacts">Contacts</a>
          <a className="btn" href="/morning">Morning →</a>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ marginBottom: 20 }}>
        <div className="rowBetween" style={{ marginBottom: 6 }}>
          <span className="muted small">
            {savedCount} classified · {skippedCount} skipped · {Math.max(0, totalUnclassified - savedCount - skippedCount)} remaining
          </span>
          <span className="muted small">{progress}%</span>
        </div>
        <div style={{ height: 6, background: "rgba(0,0,0,0.08)", borderRadius: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${progress}%`, background: "#121212", borderRadius: 3, transition: "width 0.3s" }} />
        </div>
      </div>

      {error && <div className="alert alertError" style={{ marginBottom: 12 }}>{error}</div>}

      {done ? (
        <div className="card cardPad" style={{ textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
          <div style={{ fontWeight: 900, fontSize: 20, marginBottom: 8 }}>All done!</div>
          <div className="muted" style={{ marginBottom: 20 }}>
            {savedCount} contacts classified · {skippedCount} skipped
          </div>
          <div className="row" style={{ justifyContent: "center", gap: 8 }}>
            <a className="btn btnPrimary" href="/morning">Go to Morning →</a>
            <a className="btn" href="/contacts">View Contacts</a>
          </div>
        </div>
      ) : (
        <>
          {/* Contact card */}
          <div className="card cardPad" style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div>
                <div style={{ fontWeight: 900, fontSize: 22 }}>{current?.display_name}</div>
                {(current?.email || current?.company) && (
                  <div className="muted" style={{ marginTop: 4, fontSize: 14 }}>
                    {[current.email, current.company].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              <div className="muted small" style={{ textAlign: "right", flexShrink: 0, marginLeft: 12 }}>
                {idx + 1} / {contacts.length}
              </div>
            </div>

            {sug && (
              <div style={{ marginBottom: 12, padding: "8px 12px", background: "rgba(0,0,0,0.04)", borderRadius: 6, fontSize: 13 }}>
                <span style={{ fontWeight: 700 }}>AI suggests:</span>{" "}
                {sug.category} · Tier {sug.tier}
                {sug.reason && <span className="muted"> — {sug.reason}</span>}
              </div>
            )}
            {classifying && !sug && (
              <div className="muted small" style={{ marginBottom: 12 }}>Classifying…</div>
            )}

            {current?.notes && (
              <div className="muted small" style={{ fontSize: 12, maxHeight: 60, overflow: "hidden", marginBottom: 12, lineHeight: 1.5 }}>
                {current.notes.slice(0, 200)}{current.notes.length > 200 ? "…" : ""}
              </div>
            )}

            {/* Category selection */}
            <div style={{ marginBottom: 10 }}>
              <div className="label" style={{ marginBottom: 6 }}>Category <span className="muted small">(keys 1–6)</span></div>
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                {CATEGORIES.map((cat, i) => (
                  <button
                    key={cat}
                    className={`btn${selectedCat === cat ? " btnPrimary" : ""}`}
                    style={{ fontSize: 13, minWidth: 80 }}
                    onClick={() => setSelectedCat(cat)}
                  >
                    <span className="muted" style={{ fontSize: 11, marginRight: 4 }}>{i + 1}</span>{cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Tier selection — clicking saves + advances */}
            <div style={{ marginBottom: 16 }}>
              <div className="label" style={{ marginBottom: 6 }}>
                Tier — click to save &amp; next <span className="muted small">(keys A / B / C)</span>
              </div>
              <div className="row" style={{ gap: 8 }}>
                {TIERS.map((tier) => (
                  <button
                    key={tier}
                    className={`btn${selectedTier === tier ? " btnPrimary" : ""}`}
                    style={{ fontSize: 15, fontWeight: 800, minWidth: 64, padding: "8px 20px" }}
                    onClick={() => saveAndAdvance(selectedCat || "Other", tier)}
                    disabled={saving}
                  >
                    {tier}
                  </button>
                ))}
                <button
                  className="btn"
                  style={{ fontSize: 13, marginLeft: 8 }}
                  onClick={skip}
                  disabled={saving}
                >
                  Skip (S)
                </button>
              </div>
            </div>

            <div className="muted small">
              Tier A = monthly · Tier B = every 60 days · Tier C = every 90 days
            </div>
          </div>

          {/* Upcoming contacts preview */}
          {contacts.slice(idx + 1, idx + 4).length > 0 && (
            <div className="muted small" style={{ paddingLeft: 4 }}>
              Up next: {contacts.slice(idx + 1, idx + 4).map((c) => c.display_name).join(" · ")}
            </div>
          )}
        </>
      )}
    </div>
  );
}
