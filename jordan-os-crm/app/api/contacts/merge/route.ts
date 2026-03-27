import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { uid, source_id, target_id } = body;

  if (!uid || !source_id || !target_id)
    return NextResponse.json({ error: "uid, source_id, target_id required" }, { status: 400 });

  if (source_id === target_id)
    return NextResponse.json({ error: "source and target must be different" }, { status: 400 });

  // Verify both contacts belong to this user
  const { data: contacts, error: cErr } = await supabaseAdmin
    .from("contacts")
    .select("id, display_name, user_id")
    .in("id", [source_id, target_id]);

  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });

  const source = contacts?.find((c) => c.id === source_id);
  const target = contacts?.find((c) => c.id === target_id);

  if (!source || source.user_id !== uid)
    return NextResponse.json({ error: "Source contact not found" }, { status: 404 });
  if (!target || target.user_id !== uid)
    return NextResponse.json({ error: "Target contact not found" }, { status: 404 });

  // Move all touches from source → target
  const { data: movedTouches, error: tErr } = await supabaseAdmin
    .from("touches")
    .update({ contact_id: target_id })
    .eq("contact_id", source_id)
    .select("id");
  const touchesMoved = movedTouches?.length ?? 0;

  if (tErr) return NextResponse.json({ error: `Touch reassign failed: ${tErr.message}` }, { status: 500 });

  // Archive source contact
  const { error: aErr } = await supabaseAdmin
    .from("contacts")
    .update({ archived: true })
    .eq("id", source_id);

  if (aErr) return NextResponse.json({ error: `Archive failed: ${aErr.message}` }, { status: 500 });

  return NextResponse.json({
    ok: true,
    touchesMoved: touchesMoved ?? 0,
    sourceName: source.display_name,
    targetName: target.display_name,
  });
}
