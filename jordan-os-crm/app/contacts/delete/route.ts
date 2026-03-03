import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

type Body = { uid: string; contact_id: string };

export async function POST(req: Request) {
    const body = (await req.json()) as Body;

    const uid = body?.uid || "";
    const contact_id = body?.contact_id || "";

    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
    if (!isUuid(contact_id)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 });

    // Confirm ownership
    const { data: c, error: cErr } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .eq("id", contact_id)
        .eq("user_id", uid)
        .single();

    if (cErr || !c) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

    // Delete dependents first (prevents FK constraint failures)
    const { error: tErr } = await supabaseAdmin.from("touches").delete().eq("contact_id", contact_id);
    if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });

    const { error: tmErr } = await supabaseAdmin
        .from("text_messages")
        .delete()
        .eq("user_id", uid)
        .eq("contact_id", contact_id);
    if (tmErr) return NextResponse.json({ error: tmErr.message }, { status: 500 });

    const { error: thErr } = await supabaseAdmin
        .from("text_threads")
        .delete()
        .eq("user_id", uid)
        .eq("contact_id", contact_id);
    if (thErr) return NextResponse.json({ error: thErr.message }, { status: 500 });

    // Finally delete contact
    const { error: delErr } = await supabaseAdmin.from("contacts").delete().eq("id", contact_id).eq("user_id", uid);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

    return NextResponse.json({ ok: true });
}