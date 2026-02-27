import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function guessDisplayNameFromEmail(email: string) {
  const local = email.split("@")[0] || email;
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

type Body = {
  uid: string;
  email: string;
  category?: string; // Client / Agent / Developer / Vendor / Other
  tier?: "A" | "B" | "C";
  client_type?: string | null;
  display_name?: string;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const uid = body.uid || "";
    const emailRaw = body.email || "";

    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
    if (!emailRaw.trim()) return NextResponse.json({ error: "Missing email" }, { status: 400 });

    const email = normalizeEmail(emailRaw);

    // 1) If contact_emails already has it, return that contact
    const { data: existingEmail } = await supabaseAdmin
      .from("contact_emails")
      .select("contact_id, email")
      .eq("email", email)
      .maybeSingle();

    if (existingEmail?.contact_id) {
      return NextResponse.json({ ok: true, created: false, contact_id: existingEmail.contact_id, email });
    }

    const category = body.category?.trim() || "Agent";
    const tier = body.tier || "C";

    const display_name =
      body.display_name?.trim() || guessDisplayNameFromEmail(email);

    // 2) Create contact
    const { data: newContact, error: cErr } = await supabaseAdmin
      .from("contacts")
      .insert({
        user_id: uid,
        display_name,
        category,
        tier,
        client_type: body.client_type ?? null,
      })
      .select("id")
      .single();

    if (cErr || !newContact?.id) {
      return NextResponse.json({ error: cErr?.message || "Failed to create contact" }, { status: 500 });
    }

    // 3) Attach email
    const { error: eErr } = await supabaseAdmin.from("contact_emails").insert({
      contact_id: newContact.id,
      email,
      label: "primary",
    });

    if (eErr) {
      return NextResponse.json(
        { error: `Contact created but email insert failed: ${eErr.message}`, contact_id: newContact.id },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, created: true, contact_id: newContact.id, email, display_name, category, tier });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e || "Unknown error") }, { status: 500 });
  }
}