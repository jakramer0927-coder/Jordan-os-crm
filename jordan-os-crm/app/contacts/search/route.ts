import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const uid = url.searchParams.get("uid") || "";
  const q = (url.searchParams.get("q") || "").trim();

  if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
  if (!q) return NextResponse.json({ results: [] });

  const { data, error } = await supabaseAdmin
    .from("contacts")
    .select("id, display_name, category, tier, email")
    .ilike("display_name", `%${q}%`)
    .order("created_at", { ascending: false })
    .limit(15);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ results: data ?? [] });
}