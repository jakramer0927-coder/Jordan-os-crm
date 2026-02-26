import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(`${process.env.APP_BASE_URL}/settings/integrations?error=missing_code_or_state`);
  }

  const { data: st, error: stErr } = await supabaseAdmin
    .from("google_oauth_states")
    .select("user_id")
    .eq("state", state)
    .single();

  if (stErr || !st?.user_id) {
    return NextResponse.redirect(`${process.env.APP_BASE_URL}/settings/integrations?error=bad_state`);
  }

  const oauth2 = getGoogleOAuthClient();
  const { tokens } = await oauth2.getToken(code);

  // Upsert tokens
  const { error: upErr } = await supabaseAdmin.from("google_tokens").upsert(
    {
      user_id: st.user_id,
      access_token: tokens.access_token ?? null,
      refresh_token: tokens.refresh_token ?? null,
      scope: tokens.scope ?? null,
      token_type: tokens.token_type ?? null,
      expiry_date: tokens.expiry_date ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  // Clean up state
  await supabaseAdmin.from("google_oauth_states").delete().eq("state", state);

  if (upErr) {
    return NextResponse.redirect(`${process.env.APP_BASE_URL}/settings/integrations?error=token_save_failed`);
  }

  return NextResponse.redirect(`${process.env.APP_BASE_URL}/settings/integrations?connected=1`);
}