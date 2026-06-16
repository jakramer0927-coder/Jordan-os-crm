import { NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient, GOOGLE_SCOPES } from "@/lib/google";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const uid = await getVerifiedUid();
  if (!uid) return unauthorized();

  // purpose=extra_mailbox connects an ADDITIONAL Gmail account for voice
  // harvesting without replacing the primary connection.
  const purpose = new URL(req.url).searchParams.get("purpose") === "extra_mailbox"
    ? "extra_mailbox"
    : "primary";

  const state = crypto.randomBytes(24).toString("hex");
  // State expires in 10 minutes
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { error: insErr } = await supabaseAdmin.from("google_oauth_states").insert({
    state,
    user_id: uid,
    expires_at: expiresAt,
    purpose,
  });

  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  const oauth2 = getGoogleOAuthClient();
  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    // Force the account chooser so a second mailbox can be picked
    prompt: "consent select_account",
    scope: GOOGLE_SCOPES,
    state,
  });

  return NextResponse.json({ url: authUrl });
}
