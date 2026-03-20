import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function normEmail(s: string): string {
  return (s || "").toLowerCase().trim();
}

function displayFromEmail(email: string): string {
  const local = email.split("@")[0] || email;
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean);
  const titled = words.map((w) => (w.length ? w[0].toUpperCase() + w.slice(1) : w));
  return titled.join(" ") || email;
}

function safeErr(e: unknown) {
  const anyE = e as { message?: unknown; name?: unknown; stack?: unknown };
  return {
    message: String(anyE?.message || e || "Unknown error"),
    name: String(anyE?.name || ""),
    stack: typeof anyE?.stack === "string" ? anyE.stack.split("\n").slice(0, 12).join("\n") : "",
  };
}

type Body = {
  uid: string;
  email: string;
  category?: string; // optional override
  tier?: string | null;
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;

    const uid = body?.uid || "";
    const email = normEmail(body?.email || "");

    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
    if (!email || !email.includes("@"))
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });

    // 1) Create contact
    const display_name = displayFromEmail(email);
    const category = body?.category || "Client";
    const tier = body?.tier ?? null;

    const { data: insC, error: insCErr } = await supabaseAdmin
      .from("contacts")
      .insert({
        user_id: uid,
        display_name,
        category,
        tier,
        email, // keep legacy single email if you still have it
      })
      .select("id, display_name")
      .single();

    if (insCErr || !insC) {
      return NextResponse.json(
        { error: insCErr?.message || "Failed to create contact" },
        { status: 500 },
      );
    }

    const contactId = String((insC as { id: string }).id);

    // 2) Add email to contact_emails (dedupe handled by constraint if you created one)
    const { error: ceErr } = await supabaseAdmin.from("contact_emails").insert({
      contact_id: contactId,
      email,
      created_at: new Date().toISOString(),
    });

    // If it errors due to duplicate, ignore
    if (ceErr && !/duplicate key/i.test(ceErr.message)) {
      return NextResponse.json(
        { error: `contact_emails insert failed: ${ceErr.message}` },
        { status: 500 },
      );
    }

    // 3) Mark unmatched row as auto_created + attach created_contact_id
    const { error: upErr } = await supabaseAdmin
      .from("unmatched_recipients")
      .update({
        status: "auto_created",
        created_contact_id: contactId,
      })
      .eq("user_id", uid)
      .eq("email", email);

    if (upErr) {
      return NextResponse.json(
        { error: `unmatched update failed: ${upErr.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, contact_id: contactId, display_name });
  } catch (e) {
    const se = safeErr(e);
    console.error("UNMATCHED_ADD_CONTACT_CRASH", se);
    return NextResponse.json({ error: "Add contact crashed", details: se }, { status: 500 });
  }
}
