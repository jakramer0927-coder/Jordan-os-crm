"use client";

import { useEffect } from "react";
import { supabase } from "@/lib/supabase/client";

export default function HomePage() {
  useEffect(() => {
    const run = async () => {
      const { data } = await supabase.auth.getSession();

      if (data.session) {
        window.location.href = "/contacts";
      } else {
        window.location.href = "/login";
      }
    };

    run();
  }, []);

  return <div style={{ padding: 40 }}>Loading…</div>;
}