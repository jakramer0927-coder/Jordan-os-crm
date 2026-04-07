import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const uid = await getVerifiedUid();
  if (!uid) return unauthorized();

  const body = await req.json().catch(() => ({}));

  const contact_id = String(body.contact_id || "");
  const channel = String(body.channel || "other");
  const direction = String(body.direction || "outbound");
  const intent = body.intent ?? null;
  const occurred_at = body.occurred_at ? String(body.occurred_at) : new Date().toISOString();
  const summary = body.summary ? String(body.summary).trim() || null : null;
  const source = String(body.source || "manual");
  const mirrorToLinked = body.mirror_to_linked !== false;

  if (!contact_id) return NextResponse.json({ error: "contact_id required" }, { status: 400 });

  // Verify contact belongs to the authenticated user
  const { data: owned, error: ownErr } = await supabaseAdmin
    .from("contacts")
    .select("id")
    .eq("id", contact_id)
    .eq("user_id", uid)
    .single();

  if (ownErr || !owned) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

  const { data: primary, error: primaryErr } = await supabaseAdmin
    .from("touches")
    .insert({ contact_id, channel, direction, intent, occurred_at, summary, source })
    .select("id")
    .single();

  if (primaryErr) return NextResponse.json({ error: primaryErr.message }, { status: 500 });

  let mirrored: string[] = [];

  if (mirrorToLinked) {
    const { data: links } = await supabaseAdmin
      .from("contact_links")
      .select("contact_id_a, contact_id_b")
      .or(`contact_id_a.eq.${contact_id},contact_id_b.eq.${contact_id}`);

    const linkedIds = (links ?? []).map((row: any) =>
      row.contact_id_a === contact_id ? row.contact_id_b : row.contact_id_a
    );

    if (linkedIds.length > 0) {
      const mirrorRows = linkedIds.map((id: string) => ({
        contact_id: id,
        channel,
        direction,
        intent,
        occurred_at,
        summary: summary ? `[Mirrored from household] ${summary}` : "[Mirrored from household]",
        source: "mirrored",
      }));

      const { data: mirroredData } = await supabaseAdmin
        .from("touches")
        .insert(mirrorRows)
        .select("id, contact_id");

      mirrored = (mirroredData ?? []).map((r: any) => r.contact_id);
    }
  }

  return NextResponse.json({ ok: true, touch_id: primary.id, mirrored });
}
