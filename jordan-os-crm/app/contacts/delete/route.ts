import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

type Body = {
    uid: string;
    contact_id: string;
};

export async function POST(req: Request) {
    try {
        const body = (await req.json()) as Body;
        const uid = body?.uid || "";
        const contactId = body?.contact_id || "";

        if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
        if (!isUuid(contactId)) return NextResponse.json({ error: "Invalid contact_id" }, { status: 400 });

        // 1) Verify contact belongs to user
        const { data: c, error: cErr } = await supabaseAdmin
            .from("contacts")
            .select("id")
            .eq("id", contactId)
            .eq("user_id", uid)
            .single();

        if (cErr || !c) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

        // 2) Delete dependent rows (add more tables here as needed)
        const del1 = await supabaseAdmin.from("touches").delete().eq("contact_id", contactId);
        if (del1.error) return NextResponse.json({ error: del1.error.message }, { status: 500 });

        const del2 = await supabaseAdmin.from("text_messages").delete().eq("contact_id", contactId);
        if (del2.error) return NextResponse.json({ error: del2.error.message }, { status: 500 });

        const del3 = await supabaseAdmin.from("text_threads").delete().eq("contact_id", contactId);
        if (del3.error) return NextResponse.json({ error: del3.error.message }, { status: 500 });

        // If you have these tables, uncomment:
        // const del4 = await supabaseAdmin.from("contact_emails").delete().eq("contact_id", contactId);
        // if (del4.error) return NextResponse.json({ error: del4.error.message }, { status: 500 });

        // 3) Delete the contact
        const delC = await supabaseAdmin.from("contacts").delete().eq("id", contactId).eq("user_id", uid);
        if (delC.error) return NextResponse.json({ error: delC.error.message }, { status: 500 });

        return NextResponse.json({ ok: true });
    } catch (e: any) {
        return NextResponse.json({ error: e?.message || "Delete crashed" }, { status: 500 });
    }
}