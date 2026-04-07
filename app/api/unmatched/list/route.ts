import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const url = new URL(req.url);
    const includeIgnored = (url.searchParams.get("includeIgnored") || "false") === "true";
    const limit = Math.min(300, Math.max(1, Number(url.searchParams.get("limit") || 150)));
    const cursor = url.searchParams.get("cursor");

    let q = supabaseAdmin
      .from("unmatched_recipients")
      .select("id, email, first_seen_at, last_seen_at, seen_count, last_subject, last_snippet, last_thread_link, status, created_contact_id")
      .eq("user_id", uid)
      .order("last_seen_at", { ascending: false })
      .limit(limit);

    if (!includeIgnored) {
      q = q.neq("status", "ignored").neq("status", "linked").neq("status", "auto_created");
    }
    if (cursor) q = q.lt("last_seen_at", cursor);

    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = data ?? [];
    const nextCursor = rows.length > 0 ? rows[rows.length - 1]!.last_seen_at : null;
    return NextResponse.json({ rows, nextCursor, limit, includeIgnored });
  } catch (e) {
    return serverError("UNMATCHED_LIST_CRASH", e);
  }
}
