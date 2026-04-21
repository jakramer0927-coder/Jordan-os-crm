import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").toLowerCase().trim();
    if (!email) return NextResponse.json({ error: "Missing email" }, { status: 400 });

    const { error } = await supabaseAdmin
      .from("unmatched_recipients")
      .update({ status: "ignored", last_seen_at: new Date().toISOString() })
      .eq("email", email)
      .eq("user_id", uid);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("UNMATCHED_IGNORE_CRASH", e);
  }
}
