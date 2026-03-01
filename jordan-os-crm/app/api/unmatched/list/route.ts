import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function safeErr(e: unknown) {
  const anyE = e as { message?: unknown; name?: unknown; stack?: unknown };
  return {
    message: String(anyE?.message || e || "Unknown error"),
    name: String(anyE?.name || ""),
    stack: typeof anyE?.stack === "string" ? anyE.stack.split("\n").slice(0, 12).join("\n") : "",
  };
}

type UnmatchedRow = {
  id: string;
  user_id: string;
  email: string;
  first_seen_at: string;
  last_seen_at: string;
  seen_count: number;
  last_subject: string | null;
  last_snippet: string | null;
  last_thread_link: string | null;
  status: string;
  created_contact_id: string | null;
};

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const uid = url.searchParams.get("uid") || "";
    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });

    const includeIgnored = (url.searchParams.get("includeIgnored") || "false") === "true";
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 300)));
    const cursor = url.searchParams.get("cursor"); // ISO timestamp (last_seen_at) for pagination

    let q = supabaseAdmin
      .from("unmatched_recipients")
      .select(
        "id, user_id, email, first_seen_at, last_seen_at, seen_count, last_subject, last_snippet, last_thread_link, status, created_contact_id"
      )
      .eq("user_id", uid)
      .order("last_seen_at", { ascending: false })
      .limit(limit);

    if (!includeIgnored) q = q.neq("status", "ignored");
    if (cursor) q = q.lt("last_seen_at", cursor);

    const { data, error } = await q;

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (data ?? []) as UnmatchedRow[];
    const nextCursor = rows.length > 0 ? rows[rows.length - 1]!.last_seen_at : null;

    return NextResponse.json({ rows, nextCursor, limit });
  } catch (e) {
    const se = safeErr(e);
    console.error("UNMATCHED_LIST_CRASH", se);
    return NextResponse.json({ error: "Unmatched list crashed", details: se }, { status: 500 });
  }
}