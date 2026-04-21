import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] || email;
  const cleaned = local.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.split(" ").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") || email;
}

async function insertContactEmail(contactId: string, email: string, isPrimary: boolean) {
  const { error } = await supabaseAdmin.from("contact_emails").insert({
    contact_id: contactId,
    email,
    is_primary: isPrimary,
    source: "unmatched_create",
  });
  if (error && !String(error.message || "").toLowerCase().includes("duplicate")) throw error;
}

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json().catch(() => ({}));
    const email = String(body.email || "").toLowerCase().trim();
    if (!email) return NextResponse.json({ error: "Missing email" }, { status: 400 });

    const display_name = displayNameFromEmail(email);

    const { data: created, error: cErr } = await supabaseAdmin
      .from("contacts")
      .insert({ user_id: uid, display_name, category: "Agent", tier: "C", email, is_unreviewed: true, source_auto: "unmatched_manual_create" })
      .select("id")
      .single();

    if (cErr || !created?.id)
      return NextResponse.json({ error: cErr?.message || "Create failed" }, { status: 500 });

    await insertContactEmail(created.id, email, true);

    await supabaseAdmin
      .from("unmatched_recipients")
      .update({ status: "auto_created", created_contact_id: created.id })
      .eq("email", email)
      .eq("user_id", uid);

    return NextResponse.json({ ok: true, contact_id: created.id, display_name });
  } catch (e) {
    return serverError("UNMATCHED_CREATE_CRASH", e);
  }
}
