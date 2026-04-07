import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

export const runtime = "nodejs";

function safeErr(e: unknown) {
  const anyE = e as { message?: unknown; name?: unknown; stack?: unknown };
  return {
    message: String(anyE?.message || e || "Unknown error"),
    name: String(anyE?.name || ""),
    stack: typeof anyE?.stack === "string" ? anyE.stack.split("\n").slice(0, 12).join("\n") : "",
  };
}

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
    const se = safeErr(e);
    console.error("UNMATCHED_LIST_CRASH", se);
    return NextResponse.json({ error: "Unmatched list crashed", details: se }, { status: 500 });
  }
}
