import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const uid = String(body.uid || "");
  const email = String(body.email || "").toLowerCase().trim();

  if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
  if (!email) return NextResponse.json({ error: "Missing email" }, { status: 400 });

  const { error } = await supabaseAdmin
    .from("unmatched_recipients")
    .update({ status: "ignored", last_seen_at: new Date().toISOString() })
    .eq("email", email);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}