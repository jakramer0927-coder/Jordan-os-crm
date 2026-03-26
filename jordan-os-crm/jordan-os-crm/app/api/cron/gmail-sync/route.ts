// app/api/cron/gmail-sync/route.ts
// Vercel cron job — runs Gmail touches sync + voice examples sync for all connected users.
// Schedule: see vercel.json (daily at 6am PT / 14:00 UTC)

import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300; // 5 min — fits Vercel Pro limit

export async function GET(req: Request) {
  // Verify Vercel cron secret so this can't be triggered by random requests
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Derive base URL from request (works on Vercel and localhost)
  const base = new URL(req.url).origin;

  // Find all users with google_tokens (i.e. connected to Google)
  const { data: tokens, error: tokErr } = await supabaseAdmin
    .from("google_tokens")
    .select("user_id");

  if (tokErr) {
    console.error("CRON: failed to load google_tokens", tokErr.message);
    return NextResponse.json({ error: tokErr.message }, { status: 500 });
  }

  const uids = (tokens ?? []).map((r: { user_id: string }) => r.user_id).filter(Boolean);

  if (uids.length === 0) {
    return NextResponse.json({ message: "No connected users", synced: 0 });
  }

  const results: Record<string, unknown>[] = [];

  for (const uid of uids) {
    const userResult: Record<string, unknown> = { uid };

    // 1) Gmail touches sync
    try {
      const touchRes = await fetch(`${base}/api/gmail/sync?uid=${uid}`, {
        headers: { Authorization: authHeader ?? "" },
      });
      const touchJson = await touchRes.json().catch(() => ({}));
      userResult.touches = touchRes.ok
        ? { imported: touchJson.imported, skipped: touchJson.skipped, unmatched: touchJson.unmatched }
        : { error: touchJson.error || `status ${touchRes.status}` };
    } catch (e: unknown) {
      userResult.touches = { error: String((e as Error)?.message || e) };
    }

    // 2) Voice examples sync (last 90 days, up to 300 messages — lighter for daily runs)
    try {
      const voiceRes = await fetch(`${base}/api/voice/sync_gmail_sent?uid=${uid}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader ?? "",
        },
        body: JSON.stringify({ days: 90, maxMessages: 300 }),
      });
      const voiceJson = await voiceRes.json().catch(() => ({}));
      userResult.voice = voiceRes.ok
        ? { inserted: voiceJson.inserted, scanned: voiceJson.scanned, skipped: voiceJson.skipped }
        : { error: voiceJson.error || `status ${voiceRes.status}` };
    } catch (e: unknown) {
      userResult.voice = { error: String((e as Error)?.message || e) };
    }

    results.push(userResult);
    console.log("CRON gmail-sync:", JSON.stringify(userResult));
  }

  return NextResponse.json({ ok: true, synced: uids.length, results });
}
