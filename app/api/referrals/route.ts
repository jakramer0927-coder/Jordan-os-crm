import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

// GET /api/referrals — all referral_ask touches with contact names + outcome
export async function GET() {
  try {
    const serverClient = await createSupabaseServerClient();
    const { data: { session } } = await serverClient.auth.getSession();
    const uid = session?.user?.id ?? null;
    if (!uid) return unauthorized();

    const { data, error } = await supabaseAdmin
      .from("touches")
      .select("id, contact_id, occurred_at, summary, outcome, contacts(display_name, category, tier)")
      .eq("direction", "outbound")
      .eq("intent", "referral_ask")
      .order("occurred_at", { ascending: false })
      .limit(200);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Filter to this user's contacts (RLS would handle it but we're using admin)
    const { data: contactIds } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("user_id", uid);
    const owned = new Set((contactIds ?? []).map((c: any) => c.id));

    const rows = (data ?? []).filter((r: any) => owned.has(r.contact_id));
    return NextResponse.json({ referrals: rows });
  } catch (e) {
    return serverError("REFERRALS_LIST_CRASH", e);
  }
}

// PATCH /api/referrals — update outcome on a touch
export async function PATCH(req: Request) {
  try {
    const serverClient = await createSupabaseServerClient();
    const { data: { session } } = await serverClient.auth.getSession();
    const uid = session?.user?.id ?? null;
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { touch_id, outcome } = body;

    if (!touch_id) return NextResponse.json({ error: "touch_id required" }, { status: 400 });
    if (!["pending", "converted", "closed"].includes(outcome))
      return NextResponse.json({ error: "outcome must be pending, converted, or closed" }, { status: 400 });

    // Verify ownership via contact
    const { data: touch } = await supabaseAdmin
      .from("touches")
      .select("contact_id")
      .eq("id", touch_id)
      .single();

    if (!touch) return NextResponse.json({ error: "Touch not found" }, { status: 404 });

    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("id", touch.contact_id)
      .eq("user_id", uid)
      .single();

    if (!contact) return NextResponse.json({ error: "Not authorized" }, { status: 403 });

    const { error } = await supabaseAdmin
      .from("touches")
      .update({ outcome })
      .eq("id", touch_id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("REFERRALS_PATCH_CRASH", e);
  }
}
