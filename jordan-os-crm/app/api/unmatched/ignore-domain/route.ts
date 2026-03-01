import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function safeErr(e: unknown) {
  const anyE = e as { message?: unknown; name?: unknown; stack?: unknown };
  return {
    message: String(anyE?.message || e || "Unknown error"),
    name: String(anyE?.name || ""),
    stack: typeof anyE?.stack === "string" ? anyE.stack.split("\n").slice(0, 10).join("\n") : "",
  };
}

function domainOf(email: string): string {
  const parts = (email || "").toLowerCase().trim().split("@");
  return (parts[1] || "").trim();
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { uid?: string; domain?: string };
    const uid = String(body.uid || "");
    const domain = String(body.domain || "").toLowerCase().trim();

    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });
    if (!domain || !domain.includes(".")) return NextResponse.json({ error: "Invalid domain" }, { status: 400 });

    // Mark all unmatched rows for this domain as ignored
    const { error } = await supabaseAdmin
      .from("unmatched_emails")
      .update({ status: "ignored" })
      .eq("user_id", uid)
      .ilike("email", `%@${domain}`);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, domain, status: "ignored" });
  } catch (e) {
    const se = safeErr(e);
    return NextResponse.json({ error: "Ignore-domain crashed", details: se }, { status: 500 });
  }
}