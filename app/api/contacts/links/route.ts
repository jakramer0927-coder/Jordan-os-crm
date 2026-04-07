import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

// GET /api/contacts/links?contact_id=...
export async function GET(req: Request) {
  const uid = await getVerifiedUid();
  if (!uid) return unauthorized();

  const url = new URL(req.url);
  const contactId = url.searchParams.get("contact_id") ?? "";
  if (!isUuid(contactId)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 });

  // Verify contact belongs to this user
  const { data: owned } = await supabaseAdmin
    .from("contacts").select("id").eq("id", contactId).eq("user_id", uid).single();
  if (!owned) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

  const { data, error } = await supabaseAdmin
    .from("contact_links")
    .select("id, household_name, contact_id_a, contact_id_b")
    .or(`contact_id_a.eq.${contactId},contact_id_b.eq.${contactId}`);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const linkedIds = (data ?? []).map((row: any) =>
    row.contact_id_a === contactId ? row.contact_id_b : row.contact_id_a
  );

  if (linkedIds.length === 0) return NextResponse.json({ links: [] });

  const { data: contacts, error: cErr } = await supabaseAdmin
    .from("contacts")
    .select("id, display_name, category, tier")
    .in("id", linkedIds);

  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });

  const links = (data ?? []).map((row: any) => {
    const linkedId = row.contact_id_a === contactId ? row.contact_id_b : row.contact_id_a;
    const contact = (contacts ?? []).find((c: any) => c.id === linkedId);
    return { link_id: row.id, household_name: row.household_name, contact };
  }).filter((l) => l.contact != null);

  return NextResponse.json({ links });
}

// POST /api/contacts/links
export async function POST(req: Request) {
  const uid = await getVerifiedUid();
  if (!uid) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const a = String(body.contact_id_a || "");
  const b = String(body.contact_id_b || "");
  const householdName = body.household_name ? String(body.household_name).trim() : null;

  if (!isUuid(a) || !isUuid(b))
    return NextResponse.json({ error: "Invalid IDs" }, { status: 400 });
  if (a === b)
    return NextResponse.json({ error: "Cannot link a contact to itself" }, { status: 400 });

  // Verify both contacts belong to this user
  const { data: owned } = await supabaseAdmin
    .from("contacts").select("id").eq("user_id", uid).in("id", [a, b]);

  if ((owned ?? []).length < 2)
    return NextResponse.json({ error: "One or both contacts not found for this user" }, { status: 404 });

  const [idA, idB] = a < b ? [a, b] : [b, a];

  const { data, error } = await supabaseAdmin
    .from("contact_links")
    .upsert({ user_id: uid, contact_id_a: idA, contact_id_b: idB, household_name: householdName }, {
      onConflict: "contact_id_a,contact_id_b",
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, link: data });
}

// DELETE /api/contacts/links
export async function DELETE(req: Request) {
  const uid = await getVerifiedUid();
  if (!uid) return unauthorized();

  const body = await req.json().catch(() => ({}));

  if (body.link_id && isUuid(String(body.link_id))) {
    // Verify the link belongs to this user before deleting
    const { error } = await supabaseAdmin
      .from("contact_links")
      .delete()
      .eq("id", body.link_id)
      .eq("user_id", uid);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  const a = String(body.contact_id_a || "");
  const b = String(body.contact_id_b || "");
  if (!isUuid(a) || !isUuid(b))
    return NextResponse.json({ error: "Invalid IDs" }, { status: 400 });

  const [idA, idB] = a < b ? [a, b] : [b, a];
  const { error } = await supabaseAdmin
    .from("contact_links")
    .delete()
    .eq("contact_id_a", idA)
    .eq("contact_id_b", idB)
    .eq("user_id", uid);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
