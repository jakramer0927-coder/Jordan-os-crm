import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const now = new Date();
    const daysSinceMonday = (now.getDay() + 6) % 7;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - daysSinceMonday);
    weekStart.setHours(0, 0, 0, 0);

    // All three queries in parallel — contacts+touches via RPC, counts separately
    const [rpcRes, todayCountRes, weekCountRes] = await Promise.all([
      supabaseAdmin.rpc("morning_contacts", { p_uid: uid }),
      supabaseAdmin
        .from("touches")
        .select("id", { count: "exact", head: true })
        .eq("direction", "outbound")
        .gte("occurred_at", todayStart.toISOString()),
      supabaseAdmin
        .from("touches")
        .select("id", { count: "exact", head: true })
        .eq("direction", "outbound")
        .gte("occurred_at", weekStart.toISOString()),
    ]);

    if (rpcRes.error) {
      return NextResponse.json({ error: rpcRes.error.message }, { status: 500 });
    }

    const nowMs = Date.now();
    const contacts = (rpcRes.data ?? []).map((c: any) => ({
      ...c,
      days_since_outbound: c.last_outbound_at
        ? Math.max(0, Math.floor((nowMs - new Date(c.last_outbound_at).getTime()) / 86400000))
        : null,
    }));

    return NextResponse.json({
      contacts,
      todayCount: todayCountRes.count ?? 0,
      wtdCount: weekCountRes.count ?? 0,
    });
  } catch (e) {
    return serverError("MORNING_CONTACTS_CRASH", e);
  }
}
