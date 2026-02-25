"use client";

import { supabase } from "@/lib/supabase/client";

export default function LoginPage() {
  const params =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const errorMsg = params.get("error");

  async function signInWithGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  }

  return (
    <div style={{ padding: 40, maxWidth: 520 }}>
      <h1 style={{ fontSize: 28, fontWeight: 800 }}>Jordan OS CRM</h1>
      <p style={{ marginTop: 8, color: "#555" }}>Sign in to continue.</p>

      {errorMsg && (
        <div style={{ marginTop: 12, color: "crimson", fontWeight: 700 }}>
          {decodeURIComponent(errorMsg)}
        </div>
      )}

      <button
        onClick={signInWithGoogle}
        style={{
          marginTop: 18,
          padding: "10px 14px",
          cursor: "pointer",
          borderRadius: 10,
          border: "1px solid #ddd",
        }}
      >
        Sign in with Google
      </button>
    </div>
  );
}