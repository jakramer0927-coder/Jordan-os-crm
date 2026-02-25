import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      // IMPORTANT: do NOT set flowType to pkce
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    },
  }
);