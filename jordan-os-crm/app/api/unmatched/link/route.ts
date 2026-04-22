import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function isPhone(s: string): boolean {
  return s.startsWith("+") && !s.includes("@");
}

export async function POST(req: Request) {
  const uid = await getVerifiedUid();
  if (!uid) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const raw = String(body.email || "").trim();
  const email = isPhone(raw) ? raw : raw.toLowerCase();
  const contactId = String(body.contact_id || "");

  if (!email) return NextResponse.json({ error: "Missing email or phone" }, { status: 400 });
  if (!isUuid(contactId)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 });

  // Verify the contact belongs to this user
  const { data: owned } = await supabaseAdmin
    .from("contacts").select("id").eq("id", contactId).eq("user_id", uid).single();
  if (!owned) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

  if (isPhone(email)) {
    // Store phone on the contact row directly
    const { error } = await supabaseAdmin
      .from("contacts").update({ phone: email }).eq("id", contactId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supabaseAdmin.from("contact_emails").insert({
      contact_id: contactId,
      email,
      is_primary: false,
      source: "unmatched_link",
    });
    if (error && !String(error.message || "").toLowerCase().includes("duplicate"))
      return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { error } = await supabaseAdmin
    .from("unmatched_recipients")
    .update({ status: "linked", created_contact_id: contactId, last_seen_at: new Date().toISOString() })
    .eq("user_id", uid)
    .eq("email", email);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
