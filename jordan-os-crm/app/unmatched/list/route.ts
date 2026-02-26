import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const uid = url.searchParams.get("uid") || "";
  if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });

  const limit = Math.min(Number(url.searchParams.get("limit") || "200"), 500);

  const { data, error } = await supabaseAdmin
    .from("unmatched_recipients")
    .select("id, email, first_seen_at, last_seen_at, seen_count, last_subject, last_snippet, last_thread_link, status, created_contact_id")
    .neq("status", "ignored")
    .order("seen_count", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .limit(limit);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}