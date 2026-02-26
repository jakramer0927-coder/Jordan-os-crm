import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] || email;
  const cleaned = local.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
  const titled = cleaned
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return titled || email;
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
  const body = await req.json().catch(() => ({}));
  const uid = String(body.uid || "");
  const email = String(body.email || "").toLowerCase().trim();

  if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
  if (!email) return NextResponse.json({ error: "Missing email" }, { status: 400 });

  // Create an unreviewed contact (default: Agent / Tier C)
  const display_name = displayNameFromEmail(email);

  const { data: created, error: cErr } = await supabaseAdmin
    .from("contacts")
    .insert({
      display_name,
      category: "Agent",
      tier: "C",
      email,
      is_unreviewed: true,
      source_auto: "unmatched_manual_create",
    })
    .select("id")
    .single();

  if (cErr || !created?.id) return NextResponse.json({ error: cErr?.message || "Create failed" }, { status: 500 });

  await insertContactEmail(created.id, email, true);

  // Mark unmatched as auto_created + linked
  await supabaseAdmin
    .from("unmatched_recipients")
    .update({ status: "auto_created", created_contact_id: created.id })
    .eq("email", email);

  return NextResponse.json({ ok: true, contact_id: created.id, display_name });
}