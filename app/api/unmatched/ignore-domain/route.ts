import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized } from "@/lib/supabase/server";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function normDomain(s: string): string {
  return (s || "").toLowerCase().trim().replace(/^@/, "");
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
  domain: string; // e.g. "smithandberg.com"
};

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = (await req.json()) as Body;
    const domain = normDomain(body?.domain || "");

    if (!domain || !domain.includes("."))
      return NextResponse.json({ error: "Invalid domain" }, { status: 400 });

    // email ilike "%@domain"
    const pattern = `%@${domain}`;

    const { data, error } = await supabaseAdmin
      .from("unmatched_recipients")
      .update({ status: "ignored" })
      .eq("user_id", uid)
      .ilike("email", pattern)
      .select("id");

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, domain, updated: (data ?? []).length });
  } catch (e) {
    const se = safeErr(e);
    console.error("UNMATCHED_IGNORE_DOMAIN_CRASH", se);
    return NextResponse.json({ error: "Ignore domain crashed", details: se }, { status: 500 });
  }
}
