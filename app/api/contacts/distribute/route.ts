import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

export const runtime = "nodejs";

// POST /api/contacts/distribute
// Copies touches, notes, and AI context from a group contact to all linked contacts,
// then archives the group contact.
//
// Body: { group_contact_id }
export async function POST(req: Request) {
  const uid = await getVerifiedUid();
  if (!uid) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const groupId = String(body.group_contact_id || "");

  if (!groupId) {
    return NextResponse.json({ error: "group_contact_id required" }, { status: 400 });
  }

  // Verify group contact belongs to user
  const { data: groupContact, error: gcErr } = await supabaseAdmin
    .from("contacts")
    .select("id, display_name, notes, ai_context, ai_context_updated_at, user_id")
    .eq("id", groupId)
    .eq("user_id", uid)
    .single();

  if (gcErr || !groupContact) {
    return NextResponse.json({ error: "Group contact not found" }, { status: 404 });
  }

  // Find all linked contacts
  const { data: links, error: linksErr } = await supabaseAdmin
    .from("contact_links")
    .select("contact_id_a, contact_id_b")
    .or(`contact_id_a.eq.${groupId},contact_id_b.eq.${groupId}`);

  if (linksErr) return NextResponse.json({ error: linksErr.message }, { status: 500 });

  const linkedIds = (links ?? []).map((row: any) =>
    row.contact_id_a === groupId ? row.contact_id_b : row.contact_id_a
  );

  if (linkedIds.length === 0) {
    return NextResponse.json({ error: "No linked contacts found. Link individual contacts first." }, { status: 400 });
  }

  // Verify linked contacts belong to this user
  const { data: linkedContacts, error: lcErr } = await supabaseAdmin
    .from("contacts")
    .select("id, display_name, notes, ai_context, user_id")
    .in("id", linkedIds)
    .eq("user_id", uid);

  if (lcErr) return NextResponse.json({ error: lcErr.message }, { status: 500 });
  if (!linkedContacts || linkedContacts.length === 0) {
    return NextResponse.json({ error: "Linked contacts not found for this user" }, { status: 404 });
  }

  // Load all touches from the group contact
  const { data: groupTouches, error: tErr } = await supabaseAdmin
    .from("touches")
    .select("channel, direction, occurred_at, intent, summary, source, source_link")
    .eq("contact_id", groupId)
    .order("occurred_at", { ascending: true });

  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });

  const touches = (groupTouches ?? []) as any[];
  let touchesCopied = 0;
  let contactsUpdated = 0;

  for (const lc of linkedContacts as any[]) {
    // --- Copy touches ---
    if (touches.length > 0) {
      // Load existing touches for this contact to avoid exact duplicates
      const { data: existingTouches } = await supabaseAdmin
        .from("touches")
        .select("occurred_at, channel, direction")
        .eq("contact_id", lc.id);

      const existingKeys = new Set(
        (existingTouches ?? []).map((t: any) => `${t.occurred_at}|${t.channel}|${t.direction}`)
      );

      const newTouches = touches
        .filter((t) => !existingKeys.has(`${t.occurred_at}|${t.channel}|${t.direction}`))
        .map((t) => ({
          contact_id: lc.id,
          channel: t.channel,
          direction: t.direction,
          occurred_at: t.occurred_at,
          intent: t.intent,
          summary: t.summary
            ? `[From ${groupContact.display_name}] ${t.summary}`
            : `[From ${groupContact.display_name}]`,
          source: t.source || "distributed",
          source_link: t.source_link ?? null,
        }));

      if (newTouches.length > 0) {
        const { error: insErr } = await supabaseAdmin.from("touches").insert(newTouches);
        if (!insErr) touchesCopied += newTouches.length;
      }
    }

    // --- Merge notes ---
    let updatedNotes = lc.notes || null;
    if (groupContact.notes) {
      const prefix = `[From ${groupContact.display_name}]: ${groupContact.notes}`;
      updatedNotes = lc.notes
        ? `${lc.notes}\n\n${prefix}`
        : prefix;
    }

    // --- Copy AI context if individual has none ---
    const updatedAiContext = lc.ai_context || groupContact.ai_context || null;
    const updatedAiContextAt = lc.ai_context
      ? undefined
      : groupContact.ai_context
      ? groupContact.ai_context_updated_at
      : undefined;

    const updatePayload: Record<string, any> = { notes: updatedNotes };
    if (updatedAiContext && !lc.ai_context) {
      updatePayload.ai_context = updatedAiContext;
      if (updatedAiContextAt) updatePayload.ai_context_updated_at = updatedAiContextAt;
    }

    const { error: uErr } = await supabaseAdmin
      .from("contacts")
      .update(updatePayload)
      .eq("id", lc.id);

    if (!uErr) contactsUpdated++;
  }

  // Archive the group contact
  await supabaseAdmin
    .from("contacts")
    .update({ archived: true })
    .eq("id", groupId);

  return NextResponse.json({
    ok: true,
    group: groupContact.display_name,
    distributed_to: (linkedContacts as any[]).map((c) => c.display_name),
    touches_copied: touchesCopied,
    contacts_updated: contactsUpdated,
  });
}
