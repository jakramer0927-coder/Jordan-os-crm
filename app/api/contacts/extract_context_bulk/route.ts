import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Returns all contact_ids for this user that have text_messages
export async function GET(req: Request) {
  const uid = await getVerifiedUid();
  if (!uid) return unauthorized();

  const { data, error } = await supabaseAdmin
    .from("text_messages")
    .select("contact_id")
    .eq("user_id", uid)
    .not("contact_id", "is", null);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const contactIds = Array.from(new Set((data ?? []).map((r: any) => r.contact_id).filter(Boolean)));

  // Also fetch display names for progress display
  const { data: contacts } = await supabaseAdmin
    .from("contacts")
    .select("id, display_name, ai_context_updated_at")
    .in("id", contactIds);

  const contactMap = new Map((contacts ?? []).map((c: any) => [c.id, c]));

  return NextResponse.json({
    contact_ids: contactIds,
    contacts: contactIds.map((id) => ({
      id,
      display_name: (contactMap.get(id) as any)?.display_name ?? "Unknown",
      already_extracted: !!(contactMap.get(id) as any)?.ai_context_updated_at,
    })),
  });
}
