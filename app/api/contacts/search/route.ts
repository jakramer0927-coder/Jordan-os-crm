import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const uid = await getVerifiedUid();
  if (!uid) return unauthorized();

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();

  if (!q || q.length < 2) return NextResponse.json({ results: [] });

  const { data, error } = await supabaseAdmin
    .from("contacts")
    .select("id, display_name, category, tier, email, phone, company, notes, client_type")
    .eq("user_id", uid)
    .eq("archived", false)
    .or(`display_name.ilike.%${q}%,email.ilike.%${q}%,company.ilike.%${q}%`)
    .order("updated_at", { ascending: false })
    .limit(25);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ results: data ?? [] });
}
