import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function safeStr(s: string) {
  return (s || "").trim();
}

// PostgREST `.or()` is fragile if the value contains commas or parentheses.
// Keep it simple: strip characters that can break the filter grammar.
function sanitizeForOrValue(s: string) {
  return s
    .replace(/[,%]/g, " ") // commas break `.or(...)` list; % can be abused
    .replace(/[()]/g, " ") // avoid grouping chars
    .replace(/\s+/g, " ")
    .trim();
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const uid = safeStr(url.searchParams.get("uid") || "");
  const qRaw = safeStr(url.searchParams.get("q") || "");

  if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });

  // guard
  if (!qRaw || qRaw.length < 2) return NextResponse.json({ results: [] });

  const q = sanitizeForOrValue(qRaw);
  if (!q || q.length < 2) return NextResponse.json({ results: [] });

  const pat = `%${q}%`;

  const { data, error } = await supabaseAdmin
    .from("contacts")
    .select("id, display_name, category, tier, email, company")
    .eq("user_id", uid)
    .or(`display_name.ilike.${pat},email.ilike.${pat},company.ilike.${pat}`)
    .order("updated_at", { ascending: false })
    .limit(25);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ results: data ?? [] });
}
