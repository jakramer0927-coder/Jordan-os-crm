"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
const supabase = createSupabaseBrowserClient();

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // If already logged in, go to contacts
  useEffect(() => {
    const check = async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        window.location.href = "/contacts";
      }
    };
    check();
  }, []);

  async function signInWithGoogle() {
    try {
      setLoading(true);
      setError(null);

      // Sign out any existing session first so Google always shows the account picker
      await supabase.auth.signOut();

      // Determine base URL (works local + production)
      const base =
        process.env.NEXT_PUBLIC_APP_BASE_URL &&
          process.env.NEXT_PUBLIC_APP_BASE_URL.startsWith("http")
          ? process.env.NEXT_PUBLIC_APP_BASE_URL
          : window.location.origin;

      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: `${base}/auth/callback` as string,
          queryParams: { prompt: "select_account" },
        },
      });

      if (error) {
        setError(error.message);
        setLoading(false);
      }
    } catch (e: any) {
      setError(e?.message || "Login failed");
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        padding: "48px 40px",
        maxWidth: 440,
        margin: "84px auto",
        background: "var(--paper)",
        border: "1px solid var(--line)",
        borderRadius: 16,
        textAlign: "center",
        boxShadow: "var(--shadow)",
      }}
    >
      <div className="eyebrow" style={{ marginBottom: 6 }}>Private CRM</div>
      <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontSize: 40, letterSpacing: "-0.5px", margin: 0, color: "var(--ink)" }}>Dex</h1>
      <p style={{ color: "var(--muted)", margin: "12px 0 32px", fontSize: 14, lineHeight: 1.5 }}>
        Sign in with Google to access your private CRM.
      </p>

      {error && <div className="alert alertError" style={{ marginBottom: 16, textAlign: "left" }}>{error}</div>}

      <button
        className="btn btnPrimary"
        onClick={signInWithGoogle}
        disabled={loading}
        style={{ width: "100%", justifyContent: "center", padding: "12px 18px", fontSize: 14 }}
      >
        {loading ? "Redirecting…" : "Sign in with Google"}
      </button>
    </div>
  );
}
