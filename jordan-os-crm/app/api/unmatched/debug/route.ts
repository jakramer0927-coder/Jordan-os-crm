import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Diagnostic endpoint — returns raw table state for debugging
export async function GET() {
  // Try a plain count with no filters
  const { data: allRows, error: allErr } = await supabaseAdmin
    .from("unmatched_recipients")
    .select("id, email, status, seen_count, last_seen_at")
    .order("last_seen_at", { ascending: false })
    .limit(20);

  // Try a count grouped by status
  const { data: statusRows, error: statusErr } = await supabaseAdmin
    .from("unmatched_recipients")
    .select("status")
    .limit(500);

  const statusCounts: Record<string, number> = {};
  for (const r of statusRows ?? []) {
    const s = (r as any).status ?? "null";
    statusCounts[s] = (statusCounts[s] || 0) + 1;
  }

  return NextResponse.json({
    tableError: allErr?.message ?? null,
    totalFetched: (allRows ?? []).length,
    statusCounts,
    sample: allRows ?? [],
    statusFetchError: statusErr?.message ?? null,
  });
}
