import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const serverClient = await createSupabaseServerClient();
    const { data: { session } } = await serverClient.auth.getSession();
    const uid = session?.user?.id ?? null;
    if (!uid) return unauthorized();

    const url = new URL(req.url);
    const includeClosed = url.searchParams.get("include_closed") === "1";

    let query = supabaseAdmin
      .from("deals")
      .select(`
        id, address, role, status, price, close_date, notes, created_at, stage_entered_at,
        referral_source_contact_id,
        contact:contact_id(id, display_name, category, tier),
        referral_source:referral_source_contact_id(id, display_name)
      `)
      .eq("user_id", uid)
      .order("created_at", { ascending: false });

    if (!includeClosed) {
      query = query.not("status", "in", '("closed_won","closed_lost")');
    }

    const { data, error } = await query;

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ deals: data ?? [] });
  } catch (e) {
    return serverError("PIPELINE_CRASH", e);
  }
}
