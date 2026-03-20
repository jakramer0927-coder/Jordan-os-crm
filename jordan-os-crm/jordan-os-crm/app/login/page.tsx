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
        padding: 40,
        maxWidth: 500,
        margin: "60px auto",
        border: "1px solid #e5e5e5",
        borderRadius: 16,
        textAlign: "center",
      }}
    >
      <h1 style={{ marginBottom: 10 }}>Jordan OS CRM</h1>
      <p style={{ color: "#666", marginBottom: 30 }}>
        Sign in with Google to access your private CRM.
      </p>

      {error && <div style={{ color: "crimson", marginBottom: 14, fontWeight: 700 }}>{error}</div>}

      <button
        onClick={signInWithGoogle}
        disabled={loading}
        style={{
          padding: "12px 18px",
          borderRadius: 12,
          border: "1px solid #ddd",
          fontWeight: 900,
          cursor: "pointer",
          fontSize: 14,
        }}
      >
        {loading ? "Redirecting…" : "Sign in with Google"}
      </button>
    </div>
  );
}
