"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

export default function AuthCallbackPage() {
  const [details, setDetails] = useState<any>({ status: "starting" });

  useEffect(() => {
    const run = async () => {
      const href = window.location.href;
      const search = window.location.search;
      const hash = window.location.hash;

      const url = new URL(href);
      const code = url.searchParams.get("code");

      let exchangeError: string | null = null;

      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        exchangeError = error?.message ?? null;
      }

      const { data: sess, error: sessErr } = await supabase.auth.getSession();

      setDetails({
        href,
        search,
        hash,
        hasCode: !!code,
        exchangeError,
        sessionError: sessErr?.message ?? null,
        hasSession: !!sess.session,
        userId: sess.session?.user?.id ?? null,
        storageKeys: Object.keys(localStorage).filter((k) =>
          k.toLowerCase().includes("supabase")
        ),
      });
    };

    run();
  }, []);

  return (
    <div style={{ padding: 40 }}>
      <h1 style={{ fontSize: 22, fontWeight: 800 }}>Auth Callback Status</h1>
      <p style={{ color: "#555" }}>
        This page is intentionally not redirecting. It shows what auth returned.
      </p>
      <pre style={{ background: "#f6f6f6", padding: 12, borderRadius: 8, overflow: "auto" }}>
        {JSON.stringify(details, null, 2)}
      </pre>
      <div style={{ marginTop: 12 }}>
        <a href="/login">Back to login</a> • <a href="/contacts">Go to contacts</a>
      </div>
    </div>
  );
}