import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export async function POST(req: Request) {
  const uid = await getVerifiedUid();
  if (!uid) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || ""); // "archive" | "delete"
  const ids: string[] = Array.isArray(body.ids) ? body.ids.filter((id: unknown) => typeof id === "string" && isUuid(id)) : [];

  if (!["archive", "delete"].includes(action)) return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  if (ids.length === 0) return NextResponse.json({ error: "No valid IDs" }, { status: 400 });
  if (ids.length > 200) return NextResponse.json({ error: "Too many IDs (max 200)" }, { status: 400 });

  // Verify all contacts belong to this user
  const { data: owned, error: ownErr } = await supabaseAdmin
    .from("contacts")
    .select("id")
    .eq("user_id", uid)
    .in("id", ids);

  if (ownErr) return NextResponse.json({ error: ownErr.message }, { status: 500 });
  const ownedIds = (owned ?? []).map((r: any) => r.id as string);
  if (ownedIds.length === 0) return NextResponse.json({ error: "No matching contacts found" }, { status: 404 });

  if (action === "archive") {
    const { error } = await supabaseAdmin
      .from("contacts")
      .update({ archived: true })
      .in("id", ownedIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, affected: ownedIds.length });
  }

  if (action === "delete") {
    // Delete in dependency order
    await supabaseAdmin.from("touches").delete().in("contact_id", ownedIds);
    await supabaseAdmin.from("text_messages").delete().in("contact_id", ownedIds);
    await supabaseAdmin.from("text_threads").delete().in("contact_id", ownedIds);
    await supabaseAdmin.from("contact_emails").delete().in("contact_id", ownedIds);

    const { error } = await supabaseAdmin.from("contacts").delete().in("id", ownedIds);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, affected: ownedIds.length });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
