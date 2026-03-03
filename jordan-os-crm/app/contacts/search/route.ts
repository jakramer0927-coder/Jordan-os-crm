import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function escLike(s: string) {
  // Escape % and _ for LIKE; PostgREST supports escaping in ilike patterns.
  return s.replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const uid = url.searchParams.get("uid") || "";
  const qRaw = (url.searchParams.get("q") || "").trim();

  if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
  if (!qRaw) return NextResponse.json({ results: [] });

  const q = escLike(qRaw.slice(0, 80));
  const isEmailish = qRaw.includes("@") || qRaw.includes(".");
  const isPhoneish = /[0-9]{3}/.test(qRaw);

  // Strategy:
  // - Prefer PREFIX matches first (fast with btree/trgm).
  // - If the user types something email/phone-ish, allow contains match.
  // - Always scope by user_id.
  //
  // NOTE: PostgREST `.or()` string format.

  let orParts: string[] = [];

  if (isEmailish) {
    orParts = [
      `email.ilike.%${q}%`,
      `display_name.ilike.${q}%`,
      `company.ilike.${q}%`,
    ];
  } else if (isPhoneish) {
    orParts = [
      `phone.ilike.%${q}%`,
      `display_name.ilike.${q}%`,
      `company.ilike.${q}%`,
    ];
  } else {
    // “normal name search”: prefix match only (feels instant + avoids scanning)
    orParts = [
      `display_name.ilike.${q}%`,
      `company.ilike.${q}%`,
      `email.ilike.${q}%`,
    ];
  }

  const { data, error } = await supabaseAdmin
    .from("contacts")
    .select("id, display_name, category, tier, email")
    .eq("user_id", uid)
    .or(orParts.join(","))
    .order("created_at", { ascending: false })
    .limit(25);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ results: data ?? [] });
}