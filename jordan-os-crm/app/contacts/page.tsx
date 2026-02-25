"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

type Contact = {
  id: string;
  display_name: string;
  category: string;
  tier: string | null;
  created_at: string;
};

export default function ContactsPage() {
  const [ready, setReady] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("Client");
  const [tier, setTier] = useState<"A" | "B" | "C">("A");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function fetchContacts() {
    setError(null);
    const { data, error } = await supabase
      .from("contacts")
      .select("id, display_name, category, tier, created_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) {
      setError(`Fetch error: ${error.message}`);
      setContacts([]);
      return;
    }
    setContacts((data ?? []) as Contact[]);
  }

  async function addContact() {
    if (!name.trim()) return;
    setLoading(true);
    setError(null);

    const { data: s } = await supabase.auth.getSession();
    if (!s.session) {
      window.location.href = "/login";
      return;
    }

    const { error } = await supabase.from("contacts").insert({
      display_name: name.trim(),
      category,
      tier,
    });

    setLoading(false);

    if (error) {
      setError(`Insert error: ${error.message}`);
      return;
    }

    setName("");
    await fetchContacts();
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  useEffect(() => {
    let alive = true;

    const init = async () => {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user.id ?? null;

      if (!alive) return;

      if (!uid) {
        // Give hydration a moment, then redirect if still missing
        setTimeout(async () => {
          const { data: d2 } = await supabase.auth.getSession();
          if (!d2.session) window.location.href = "/login";
        }, 250);
        return;
      }

      setUserId(uid);
      setReady(true);
      await fetchContacts();
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
      const uid = session?.user.id ?? null;
      setUserId(uid);
      if (!uid) window.location.href = "/login";
    });

    init();

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  if (!ready) return <div style={{ padding: 40 }}>Loading…</div>;

  return (
    <div style={{ padding: 40, maxWidth: 950 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0 }}>Contacts</h1>
          <div style={{ marginTop: 6, color: "#666" }}>
            Logged in ✅ {userId ? `(user ${userId.slice(0, 8)}…)` : ""}
          </div>
        </div>
        <button onClick={signOut} style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd" }}>
          Sign out
        </button>
      </div>

      <div style={{ marginTop: 18, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          style={{ padding: 10, width: 320, borderRadius: 10, border: "1px solid #ddd" }}
        />

        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ padding: 10 }}>
          <option>Client</option>
          <option>Agent</option>
          <option>Developer</option>
          <option>Vendor</option>
          <option>Other</option>
        </select>

        <select value={tier} onChange={(e) => setTier(e.target.value as any)} style={{ padding: 10 }}>
          <option value="A">A</option>
          <option value="B">B</option>
          <option value="C">C</option>
        </select>

        <button
          onClick={addContact}
          disabled={loading}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd" }}
        >
          {loading ? "Adding…" : "Add"}
        </button>

        <button onClick={fetchContacts} style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #ddd" }}>
          Refresh
        </button>
      </div>

      {error && <div style={{ marginTop: 14, color: "crimson", fontWeight: 800 }}>{error}</div>}

      <div style={{ marginTop: 18 }}>
        {contacts.map((c) => (
          <div key={c.id} style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 12, marginBottom: 10 }}>
            <div style={{ fontWeight: 800 }}>{c.display_name}</div>
            <div style={{ color: "#555", marginTop: 4 }}>
              {c.category} {c.tier ? `• Tier ${c.tier}` : ""}
            </div>
            <div style={{ color: "#999", fontSize: 12, marginTop: 6 }}>
              {new Date(c.created_at).toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}