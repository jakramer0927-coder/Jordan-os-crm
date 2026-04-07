import { supabaseAdmin } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";

/**
 * Simple daily per-user rate limiter backed by Supabase.
 * Table required:
 *   CREATE TABLE IF NOT EXISTS ai_usage (
 *     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 *     action text NOT NULL,
 *     date date NOT NULL DEFAULT current_date,
 *     count integer NOT NULL DEFAULT 1,
 *     UNIQUE (user_id, action, date)
 *   );
 *
 * Returns a 429 NextResponse if the limit is exceeded, otherwise null.
 */
export async function checkRateLimit(
  uid: string,
  action: string,
  dailyLimit: number,
): Promise<NextResponse | null> {
  const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

  // Try to upsert: increment count or insert with count=1
  const { data, error } = await supabaseAdmin.rpc("increment_ai_usage", {
    p_user_id: uid,
    p_action: action,
    p_date: today,
  });

  if (error) {
    // If the function doesn't exist yet, fail open (don't block the user)
    console.warn("[rateLimit] increment_ai_usage RPC error — failing open:", error.message);
    return null;
  }

  const newCount = data as number;
  if (newCount > dailyLimit) {
    return NextResponse.json(
      {
        error: `Daily limit reached for '${action}' (${dailyLimit}/day). Try again tomorrow.`,
        limit: dailyLimit,
        count: newCount,
      },
      { status: 429 },
    );
  }

  return null;
}
