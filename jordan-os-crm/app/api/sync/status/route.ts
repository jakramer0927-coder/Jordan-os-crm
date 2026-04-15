import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const { data } = await supabaseAdmin
      .from("user_settings")
      .select("last_gmail_sync_at, last_calendar_sync_at")
      .eq("user_id", uid)
      .maybeSingle();

    return NextResponse.json({
      gmail: data?.last_gmail_sync_at ?? null,
      calendar: data?.last_calendar_sync_at ?? null,
    });
  } catch (e) {
    return serverError("SYNC_STATUS_CRASH", e);
  }
}
