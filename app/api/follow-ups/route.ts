import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

// GET /api/follow-ups?due_today=1  — returns due + overdue incomplete follow-ups
// GET /api/follow-ups?contact_id=  — returns all for a contact
export async function GET(req: Request) {
  try {
    const serverClient = await createSupabaseServerClient();
    const { data: { session } } = await serverClient.auth.getSession();
    const uid = session?.user?.id ?? null;
    if (!uid) return unauthorized();

    const url = new URL(req.url);
    const contactId = url.searchParams.get("contact_id");
    const dueToday = url.searchParams.get("due_today") === "1";

    let query = supabaseAdmin
      .from("follow_ups")
      .select("id, contact_id, due_date, note, created_at, contacts(id, display_name, category, tier)")
      .eq("user_id", uid)
      .is("completed_at", null)
      .order("due_date", { ascending: true });

    if (contactId && isUuid(contactId)) {
      query = query.eq("contact_id", contactId);
    } else if (dueToday) {
      const today = new Date().toISOString().slice(0, 10);
      query = query.lte("due_date", today);
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ follow_ups: data ?? [] });
  } catch (e) {
    return serverError("FOLLOW_UPS_GET_CRASH", e);
  }
}

// POST /api/follow-ups — create
export async function POST(req: Request) {
  try {
    const serverClient = await createSupabaseServerClient();
    const { data: { session } } = await serverClient.auth.getSession();
    const uid = session?.user?.id ?? null;
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { contact_id, due_date, note } = body;

    if (!isUuid(contact_id)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 });
    if (!due_date) return NextResponse.json({ error: "due_date required" }, { status: 400 });

    // Verify ownership
    const { data: contact } = await supabaseAdmin
      .from("contacts").select("id").eq("id", contact_id).eq("user_id", uid).single();
    if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

    const { data, error } = await supabaseAdmin
      .from("follow_ups")
      .insert({ user_id: uid, contact_id, due_date, note: note?.trim() || null })
      .select("id")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, id: (data as any).id });
  } catch (e) {
    return serverError("FOLLOW_UPS_POST_CRASH", e);
  }
}

// PATCH /api/follow-ups — complete
export async function PATCH(req: Request) {
  try {
    const serverClient = await createSupabaseServerClient();
    const { data: { session } } = await serverClient.auth.getSession();
    const uid = session?.user?.id ?? null;
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { id } = body;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

    const { error } = await supabaseAdmin
      .from("follow_ups")
      .update({ completed_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", uid);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("FOLLOW_UPS_PATCH_CRASH", e);
  }
}

// DELETE /api/follow-ups — delete
export async function DELETE(req: Request) {
  try {
    const serverClient = await createSupabaseServerClient();
    const { data: { session } } = await serverClient.auth.getSession();
    const uid = session?.user?.id ?? null;
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { id } = body;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

    const { error } = await supabaseAdmin
      .from("follow_ups").delete().eq("id", id).eq("user_id", uid);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("FOLLOW_UPS_DELETE_CRASH", e);
  }
}
