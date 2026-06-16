import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";
import { profileEmail } from "@/lib/googleMailboxes";
import { encryptToken } from "@/lib/tokenCrypto";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return NextResponse.redirect(
      `${process.env.APP_BASE_URL}/settings/integrations?error=missing_code_or_state`,
    );
  }

  const { data: st, error: stErr } = await supabaseAdmin
    .from("google_oauth_states")
    .select("user_id, expires_at, purpose")
    .eq("state", state)
    .single();

  if (stErr || !st?.user_id) {
    return NextResponse.redirect(
      `${process.env.APP_BASE_URL}/settings/integrations?error=bad_state`,
    );
  }

  // Reject expired state tokens
  if (st.expires_at && new Date(st.expires_at) < new Date()) {
    await supabaseAdmin.from("google_oauth_states").delete().eq("state", state);
    return NextResponse.redirect(
      `${process.env.APP_BASE_URL}/settings/integrations?error=state_expired`,
    );
  }

  const oauth2 = getGoogleOAuthClient();
  const { tokens } = await oauth2.getToken(code);

  // Identify which Gmail account was just authorized
  oauth2.setCredentials({
    access_token: tokens.access_token ?? undefined,
    refresh_token: tokens.refresh_token ?? undefined,
    expiry_date: tokens.expiry_date ?? undefined,
  });
  const connectedEmail = await profileEmail(oauth2);

  const isExtra = st.purpose === "extra_mailbox";

  let upErr: { message: string } | null = null;

  if (isExtra) {
    // Additional voice-harvesting mailbox — never touches the primary connection
    const { error } = await supabaseAdmin.from("extra_google_mailboxes").upsert(
      {
        user_id: st.user_id,
        email: connectedEmail ?? `mailbox-${Date.now()}`,
        access_token: tokens.access_token ? encryptToken(tokens.access_token) : null,
        refresh_token: tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
        scope: tokens.scope ?? null,
        token_type: tokens.token_type ?? null,
        expiry_date: tokens.expiry_date ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,email" },
    );
    upErr = error;
  } else {
    const { error } = await supabaseAdmin.from("google_tokens").upsert(
      {
        user_id: st.user_id,
        email: connectedEmail,
        access_token: tokens.access_token ? encryptToken(tokens.access_token) : null,
        refresh_token: tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
        scope: tokens.scope ?? null,
        token_type: tokens.token_type ?? null,
        expiry_date: tokens.expiry_date ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    upErr = error;
  }

  // Clean up state
  await supabaseAdmin.from("google_oauth_states").delete().eq("state", state);

  if (upErr) {
    return NextResponse.redirect(
      `${process.env.APP_BASE_URL}/settings/integrations?error=token_save_failed`,
    );
  }

  return NextResponse.redirect(`${process.env.APP_BASE_URL}/settings/integrations?connected=1`);
}
