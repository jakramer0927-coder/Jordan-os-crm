import { NextResponse } from "next/server";
import { google } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";
import { decryptToken } from "@/lib/tokenCrypto";

export const runtime = "nodejs";

type GoogleTokenRow = {
  access_token: string | null;
  refresh_token: string | null;
  expiry_date: number | null;
};

function buildRFC2822(opts: {
  to: string;
  from: string;
  subject: string;
  body: string;
}): string {
  const lines = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    opts.body,
  ];
  return lines.join("\r\n");
}

function toBase64Url(s: string): string {
  return Buffer.from(s)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json();
    const to = (body?.to || "").trim();
    const subject = (body?.subject || "(no subject)").trim();
    const text = (body?.body || "").trim();

    if (!to) return NextResponse.json({ error: "Missing 'to' address" }, { status: 400 });
    if (!text) return NextResponse.json({ error: "Missing email body" }, { status: 400 });

    // Load tokens
    const { data: tok, error: tokErr } = await supabaseAdmin
      .from("google_tokens")
      .select("access_token, refresh_token, expiry_date")
      .eq("user_id", uid)
      .single();

    if (tokErr || !tok)
      return NextResponse.json({ error: "Google not connected" }, { status: 400 });

    const tokenRow = tok as GoogleTokenRow;
    if (!tokenRow.refresh_token)
      return NextResponse.json({ error: "Missing refresh token (reconnect Google)" }, { status: 400 });

    const oauth2 = getGoogleOAuthClient();
    oauth2.setCredentials({
      access_token: tokenRow.access_token ? decryptToken(tokenRow.access_token) : undefined,
      refresh_token: tokenRow.refresh_token ? decryptToken(tokenRow.refresh_token) : undefined,
      expiry_date: tokenRow.expiry_date ?? undefined,
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2 });

    // Get sender's email address
    const profileRes = await gmail.users.getProfile({ userId: "me" });
    const from = profileRes.data.emailAddress || "";

    const raw = toBase64Url(buildRFC2822({ to, from, subject, body: text }));

    const sendRes = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    return NextResponse.json({
      ok: true,
      messageId: sendRes.data.id,
      threadId: sendRes.data.threadId,
    });
  } catch (e) {
    return serverError("GMAIL_SEND_CRASH", e);
  }
}
