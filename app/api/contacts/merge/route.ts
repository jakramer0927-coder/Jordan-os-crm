import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const uid = await getVerifiedUid();
  if (!uid) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const { source_id, target_id } = body;

  if (!source_id || !target_id)
    return NextResponse.json({ error: "source_id, target_id required" }, { status: 400 });

  if (source_id === target_id)
    return NextResponse.json({ error: "source and target must be different" }, { status: 400 });

  // Verify both contacts belong to this user (gives clean 404s before the merge).
  // The RPC re-checks ownership inside the transaction as a safety net.
  const { data: contacts, error: cErr } = await supabaseAdmin
    .from("contacts")
    .select("id, display_name")
    .eq("user_id", uid)
    .in("id", [source_id, target_id]);

  if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });

  const source = contacts?.find((c) => c.id === source_id);
  const target = contacts?.find((c) => c.id === target_id);

  if (!source)
    return NextResponse.json({ error: "Source contact not found" }, { status: 404 });
  if (!target)
    return NextResponse.json({ error: "Target contact not found" }, { status: 404 });

  // Re-point every table that references the source contact onto the target,
  // copy over missing scalar fields, and archive the source — all in one
  // transaction so a partial failure cannot orphan data under the archived record.
  const { data: result, error: mErr } = await supabaseAdmin.rpc("merge_contacts", {
    p_source: source_id,
    p_target: target_id,
    p_uid: uid,
  });

  if (mErr) return NextResponse.json({ error: `Merge failed: ${mErr.message}` }, { status: 500 });

  const moved = (result?.moved ?? {}) as Record<string, number>;

  return NextResponse.json({
    ok: true,
    sourceName: result?.source_name ?? source.display_name,
    targetName: result?.target_name ?? target.display_name,
    // Per-table row counts that were re-pointed from source → target.
    moved,
    // Back-compat with the previous response shape.
    touchesMoved: moved["touches.contact_id"] ?? 0,
  });
}
