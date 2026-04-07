import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function normEmail(s: string): string {
  return (s || "").toLowerCase().trim();
}

function displayFromEmail(email: string): string {
  const local = email.split("@")[0] || email;
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean);
  const titled = words.map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w));
  return titled.join(" ") || email;
}

type Body = {
  email: string;
  display_name?: string | null;
  category?: string;
  tier?: string | null;
};

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = (await req.json()) as Body;

    const email = normEmail(body?.email || "");

    if (!email || !email.includes("@"))
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });

    // 1) Check if a contact with this email already exists for this user
    const { data: existing } = await supabaseAdmin
      .from("contacts")
      .select("id, display_name")
      .eq("user_id", uid)
      .eq("email", email)
      .maybeSingle();

    let contactId: string;
    let display_name: string;

    if (existing) {
      // Already exists — just link it
      contactId = String(existing.id);
      display_name = String(existing.display_name);
    } else {
      // Create new contact
      display_name = (body?.display_name || "").trim() || displayFromEmail(email);
      const category = body?.category || "Agent";
      const tier = body?.tier ?? null;

      const { data: insC, error: insCErr } = await supabaseAdmin
        .from("contacts")
        .insert({
          user_id: uid,
          display_name,
          category,
          tier,
          email,
        })
        .select("id, display_name")
        .single();

      if (insCErr || !insC) {
        return NextResponse.json(
          { error: insCErr?.message || "Failed to create contact" },
          { status: 500 },
        );
      }

      contactId = String((insC as { id: string }).id);
    }

    // 2) Add email to contact_emails (dedupe handled by constraint if you created one)
    const { error: ceErr } = await supabaseAdmin.from("contact_emails").insert({
      contact_id: contactId,
      email,
      created_at: new Date().toISOString(),
    });

    // If it errors due to duplicate, ignore
    if (ceErr && !/duplicate key/i.test(ceErr.message)) {
      return NextResponse.json(
        { error: `contact_emails insert failed: ${ceErr.message}` },
        { status: 500 },
      );
    }

    // 3) Mark unmatched row as auto_created + attach created_contact_id
    const { error: upErr } = await supabaseAdmin
      .from("unmatched_recipients")
      .update({
        status: "auto_created",
        created_contact_id: contactId,
      })
      .eq("user_id", uid)
      .eq("email", email);

    if (upErr) {
      return NextResponse.json(
        { error: `unmatched update failed: ${upErr.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, contact_id: contactId, display_name });
  } catch (e) {
    return serverError("UNMATCHED_ADD_CONTACT_CRASH", e);
  }
}
