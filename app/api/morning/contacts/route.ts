import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    // Load contacts
    const { data: cData, error: cErr } = await supabaseAdmin
      .from("contacts")
      .select("id, display_name, category, tier, client_type, email, created_at")
      .eq("user_id", uid)
      .neq("archived", true)
      .order("created_at", { ascending: false })
      .limit(2000);

    if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });

    const contacts = cData ?? [];
    const ids = contacts.map((c: any) => c.id as string);

    if (ids.length === 0) {
      return NextResponse.json({ contacts: [], todayCount: 0, wtdCount: 0 });
    }

    // Aggregate latest outbound touch per contact + accountability counts in parallel
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - daysSinceMonday);
    weekStart.setHours(0, 0, 0, 0);

    const [touchesRes, todayCountRes, weekCountRes] = await Promise.all([
      supabaseAdmin
        .from("touches")
        .select("contact_id, occurred_at, channel")
        .in("contact_id", ids)
        .eq("direction", "outbound")
        .order("occurred_at", { ascending: false })
        .limit(8000),
      supabaseAdmin
        .from("touches")
        .select("id", { count: "exact", head: true })
        .in("contact_id", ids)
        .eq("direction", "outbound")
        .gte("occurred_at", todayStart.toISOString()),
      supabaseAdmin
        .from("touches")
        .select("id", { count: "exact", head: true })
        .in("contact_id", ids)
        .eq("direction", "outbound")
        .gte("occurred_at", weekStart.toISOString()),
    ]);

    const latestByContactId = new Map<string, { occurred_at: string; channel: string }>();
    for (const t of touchesRes.data ?? []) {
      if (!latestByContactId.has(t.contact_id)) {
        latestByContactId.set(t.contact_id, { occurred_at: t.occurred_at, channel: t.channel });
      }
    }

    const nowMs = Date.now();
    const merged = contacts.map((c: any) => {
      const last = latestByContactId.get(c.id) ?? null;
      const days_since_outbound = last
        ? Math.max(0, Math.floor((nowMs - new Date(last.occurred_at).getTime()) / 86400000))
        : null;
      return {
        ...c,
        last_outbound_at: last?.occurred_at ?? null,
        last_outbound_channel: last?.channel ?? null,
        days_since_outbound,
      };
    });

    return NextResponse.json({
      contacts: merged,
      todayCount: todayCountRes.count ?? 0,
      wtdCount: weekCountRes.count ?? 0,
    });
  } catch (e) {
    return serverError("MORNING_CONTACTS_CRASH", e);
  }
}
