import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

async function insertContactEmail(contactId: string, email: string) {
  const { error } = await supabaseAdmin.from("contact_emails").insert({
    contact_id: contactId,
    email,
    is_primary: false,
    source: "unmatched_link",
  });
  if (error && !String(error.message || "").toLowerCase().includes("duplicate")) throw error;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const uid = String(body.uid || "");
  const email = String(body.email || "").toLowerCase().trim();
  const contactId = String(body.contact_id || "");

  if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
  if (!email) return NextResponse.json({ error: "Missing email" }, { status: 400 });
  if (!isUuid(contactId)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 });

  await insertContactEmail(contactId, email);

  const { error } = await supabaseAdmin
    .from("unmatched_recipients")
    .update({ status: "linked", created_contact_id: contactId, last_seen_at: new Date().toISOString() })
    .eq("user_id", uid)
    .eq("email", email);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
