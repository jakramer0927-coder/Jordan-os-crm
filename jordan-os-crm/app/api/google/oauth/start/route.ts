import { NextResponse } from "next/server";
import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient, GOOGLE_SCOPES } from "@/lib/google";

export const runtime = "nodejs";

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const uid = url.searchParams.get("uid") || "";
  if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });

  const state = crypto.randomBytes(24).toString("hex");

  const { error: insErr } = await supabaseAdmin.from("google_oauth_states").insert({
    state,
    user_id: uid,
  });

  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  const oauth2 = getGoogleOAuthClient();
  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state,
  });

  return NextResponse.json({ url: authUrl });
}
