import { google } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";
import { decryptToken } from "@/lib/tokenCrypto";

export type VoiceMailbox = {
  source: "primary" | "extra";
  email: string | null;
  oauth2: ReturnType<typeof getGoogleOAuthClient>;
};

function clientFrom(row: { access_token: string | null; refresh_token: string | null; expiry_date: number | null }) {
  const oauth2 = getGoogleOAuthClient();
  oauth2.setCredentials({
    access_token: row.access_token ? decryptToken(row.access_token) : undefined,
    refresh_token: row.refresh_token ? decryptToken(row.refresh_token) : undefined,
    expiry_date: row.expiry_date ?? undefined,
  });
  return oauth2;
}

/** Best-effort fetch of the Gmail address behind a token. */
export async function profileEmail(oauth2: ReturnType<typeof getGoogleOAuthClient>): Promise<string | null> {
  try {
    const gmail = google.gmail({ version: "v1", auth: oauth2 });
    const res = await gmail.users.getProfile({ userId: "me" });
    return res.data.emailAddress ?? null;
  } catch {
    return null;
  }
}

/**
 * Every Gmail mailbox we should harvest sent-mail voice from for this user:
 * the primary connection plus any extra mailboxes they've added. Self-heals
 * the primary's stored email label when it's missing.
 */
export async function loadVoiceMailboxes(uid: string): Promise<VoiceMailbox[]> {
  const mailboxes: VoiceMailbox[] = [];

  const { data: primary } = await supabaseAdmin
    .from("google_tokens")
    .select("access_token, refresh_token, expiry_date, email")
    .eq("user_id", uid)
    .maybeSingle();

  if (primary?.refresh_token || primary?.access_token) {
    const oauth2 = clientFrom(primary);
    let email = primary.email ?? null;
    if (!email) {
      email = await profileEmail(oauth2);
      if (email) {
        await supabaseAdmin.from("google_tokens").update({ email }).eq("user_id", uid);
      }
    }
    mailboxes.push({ source: "primary", email, oauth2 });
  }

  const { data: extras } = await supabaseAdmin
    .from("extra_google_mailboxes")
    .select("email, access_token, refresh_token, expiry_date")
    .eq("user_id", uid);

  for (const row of extras ?? []) {
    mailboxes.push({ source: "extra", email: row.email, oauth2: clientFrom(row) });
  }

  return mailboxes;
}
