import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  const env = {
    has_SUPABASE_URL: !!process.env.SUPABASE_URL,
    has_SERVICE_ROLE: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    url_prefix: (process.env.SUPABASE_URL || "").slice(0, 35),
  };

  const { data, error } = await supabaseAdmin
    .from("user_voice_examples")
    .insert({
      user_id: "00000000-0000-0000-0000-000000000000",
      channel: "email",
      text: "debug write test",
      contact_category: "debug",
      intent: "check_in",
    })
    .select("id")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, env, error: error.message, details: error }, { status: 500 });
  }

  return NextResponse.json({ ok: true, env, inserted_id: data?.id ?? null });
}