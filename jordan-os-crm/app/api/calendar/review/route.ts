import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

// GET /api/calendar/review — fetch pending review queue items
export async function GET() {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const { data, error } = await supabaseAdmin
      .from("calendar_review_queue")
      .select("id, event_title, occurred_at, attendee_emails, attendee_names, google_event_id")
      .eq("user_id", uid)
      .eq("dismissed", false)
      .is("linked_contact_id", null)
      .order("occurred_at", { ascending: false })
      .limit(50);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ items: data ?? [] });
  } catch (e) {
    return serverError("CALENDAR_REVIEW_GET_CRASH", e);
  }
}

// PATCH /api/calendar/review — link to contact or dismiss
export async function PATCH(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const { id, action, contact_id } = body;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    if (!["link", "dismiss"].includes(action)) return NextResponse.json({ error: "action must be link or dismiss" }, { status: 400 });

    // Verify ownership
    const { data: item } = await supabaseAdmin
      .from("calendar_review_queue")
      .select("id, event_title, occurred_at")
      .eq("id", id)
      .eq("user_id", uid)
      .maybeSingle();
    if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });

    if (action === "dismiss") {
      await supabaseAdmin
        .from("calendar_review_queue")
        .update({ dismissed: true })
        .eq("id", id)
        .eq("user_id", uid);
      return NextResponse.json({ ok: true });
    }

    // action === "link"
    if (!contact_id) return NextResponse.json({ error: "contact_id required for link" }, { status: 400 });

    // Verify contact belongs to this user
    const { data: contact } = await supabaseAdmin
      .from("contacts")
      .select("id")
      .eq("id", contact_id)
      .eq("user_id", uid)
      .maybeSingle();
    if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

    // Log the touch
    await supabaseAdmin.from("touches").insert({
      contact_id,
      user_id: uid,
      channel: "meeting",
      direction: "outbound",
      occurred_at: item.occurred_at,
      summary: item.event_title || "Meeting",
      source: "calendar",
    });

    // Mark as linked
    await supabaseAdmin
      .from("calendar_review_queue")
      .update({ linked_contact_id: contact_id })
      .eq("id", id)
      .eq("user_id", uid);

    return NextResponse.json({ ok: true });
  } catch (e) {
    return serverError("CALENDAR_REVIEW_PATCH_CRASH", e);
  }
}
