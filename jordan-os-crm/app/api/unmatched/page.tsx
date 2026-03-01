    "use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";

type UnmatchedRecipient = { email: string; count: number };

type GmailSyncResponse = {
  imported: number;
  skipped: number;
  unmatched: number;
  messagesFetched?: number;
  messagesParsed?: number;
  matchedRecipients?: number;
  uniqueRecipientsFound?: number;
  contactsWithEmail?: number;
  topUnmatchedRecipients?: UnmatchedRecipient[];
  usedQuery?: string;
  usedLabelNames?: string[];
};

export default function UnmatchedPage() {
  const [ready, setReady] = useState(false);
  const [uid, setUid] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<GmailSyncResponse | null>(null);

  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Create contact controls
  const [categoryByEmail, setCategoryByEmail] = useState<Record<string, string>>({});
  const [tierByEmail, setTierByEmail] = useState<Record<string, "A" | "B" | "C">>({});
  const [creatingEmail, setCreatingEmail] = useState<string | null>(null);

  const unmatched = useMemo(() => res?.topUnmatchedRecipients ?? [], [res]);

  async function loadSession() {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    if (!user) {
      window.location.href = "/login";
      return;
    }
    setUid(user.id);
    setReady(true);
  }

  function setDefaultFields(email: string) {
    setCategoryByEmail((prev) => ({ ...prev, [email]: prev[email] ?? "Agent" }));
    setTierByEmail((prev) => ({ ...prev, [email]: prev[email] ?? "C" }));
  }

  async function runSync() {
    setErr(null);
    setMsg(null);
    setLoading(true);

    try {
      if (!uid) throw new Error("No session");

      const r = await fetch(`/api/gmail/sync?uid=${uid}`);
      const j = (await r.json()) as any;

      if (!r.ok) {
        setErr(j?.error || "Sync failed");
      } else {
        setRes(j as GmailSyncResponse);
        setMsg(`Sync complete. imported=${j.imported} skipped=${j.skipped} unmatched=${j.unmatched}`);
        // seed defaults for new list
        (j?.topUnmatchedRecipients ?? []).forEach((u: UnmatchedRecipient) => setDefaultFields(u.email));
      }
    } catch (e: any) {
      setErr(String(e?.message || e || "Unknown error"));
    } finally {
      setLoading(false);
    }
  }

  async function addToCRM(email: string) {
    setErr(null);
    setMsg(null);

    if (!uid) {
      setErr("No session");
      return;
    }

    const category = categoryByEmail[email] || "Agent";
    const tier = tierByEmail[email] || "C";

    setCreatingEmail(email);

    try {
      const r = await fetch("/api/unmatched/add-contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          uid,
          email,
          category,
          tier,
        }),
      });

      const j = await r.json();

      if (!r.ok) {
        setErr(j?.error || "Failed to add contact");
        return;
      }

      setMsg(`Added to CRM: ${email} → contact ${String(j.contact_id).slice(0, 8)}…`);
    } catch (e: any) {
      setErr(String(e?.message || e || "Unknown error"));
    } finally {
      setCreatingEmail(null);
    }
  }

  useEffect(() => {
    loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) return <div style={{ padding: 40 }}>Loading…</div>;

  return (
    <div style={{ padding: 40, maxWidth: 1100 }}>
      <h1 style={{ margin: 0, fontSize: 28, fontWeight: 900 }}>Unmatched</h1>
      <div style={{ color: "#666", marginTop: 8 }}>
        Review frequent outbound recipients that are not in your CRM yet. Add them with one click.
      </div>

      {(err || msg) && (
        <div style={{ marginTop: 14, color: err ? "crimson" : "green", fontWeight: 800 }}>
          {err || msg}
        </div>
      )}

      <div style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          onClick={runSync}
          disabled={loading}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
        >
          {loading ? "Running Gmail sync…" : "Refresh from Gmail"}
        </button>
      </div>

      {res && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 12, border: "1px solid #eee", background: "#fafafa" }}>
          <div style={{ fontWeight: 900 }}>Latest sync</div>
          <div style={{ marginTop: 6, color: "#444" }}>
            imported <strong>{res.imported}</strong> • skipped <strong>{res.skipped}</strong> • unmatched{" "}
            <strong>{res.unmatched}</strong>
          </div>
          <div style={{ marginTop: 6, color: "#777", fontSize: 12 }}>
            {res.usedLabelNames?.length ? `Labels: ${res.usedLabelNames.join(", ")}` : ""}
            {res.usedQuery ? ` • Query: ${res.usedQuery}` : ""}
          </div>
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        {unmatched.length === 0 ? (
          <div style={{ color: "#666" }}>Run a sync to see unmatched recipients.</div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {unmatched.map((u) => (
              <div key={u.email} style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontWeight: 900 }}>{u.email}</div>
                    <div style={{ color: "#666", marginTop: 4 }}>
                      Outbound count (last 365d): <strong>{u.count}</strong>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <label style={{ fontSize: 12, color: "#666" }}>
                      Category
                      <select
                        value={categoryByEmail[u.email] || "Agent"}
                        onChange={(e) => setCategoryByEmail((prev) => ({ ...prev, [u.email]: e.target.value }))}
                        style={{ display: "block", padding: 10, marginTop: 6 }}
                      >
                        <option>Client</option>
                        <option>Agent</option>
                        <option>Developer</option>
                        <option>Vendor</option>
                        <option>Other</option>
                      </select>
                    </label>

                    <label style={{ fontSize: 12, color: "#666" }}>
                      Tier
                      <select
                        value={tierByEmail[u.email] || "C"}
                        onChange={(e) => setTierByEmail((prev) => ({ ...prev, [u.email]: e.target.value as any }))}
                        style={{ display: "block", padding: 10, marginTop: 6 }}
                      >
                        <option value="A">A</option>
                        <option value="B">B</option>
                        <option value="C">C</option>
                      </select>
                    </label>

                    <button
                      onClick={() => addToCRM(u.email)}
                      disabled={creatingEmail === u.email}
                      style={{
                        padding: "10px 14px",
                        borderRadius: 10,
                        border: "1px solid #ddd",
                        cursor: "pointer",
                        fontWeight: 900,
                      }}
                    >
                      {creatingEmail === u.email ? "Adding…" : "Add to CRM"}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}