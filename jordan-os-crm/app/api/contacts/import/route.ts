import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

type ContactRow = {
  display_name: string;
  category: string;
  tier: string;
  client_type: string;
  email: string;
  phone: string;
  company: string;
  notes: string;
};

const VALID_CATEGORIES = new Set(["client", "agent", "developer", "vendor", "sphere", "other"]);
const VALID_TIERS = new Set(["A", "B", "C", ""]);
const VALID_CLIENT_TYPES = new Set(["buyer", "seller", "both", "investor", "past_client", ""]);

export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const body = await req.json();
    const rows = (body?.rows ?? []) as ContactRow[];

    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ error: "No rows provided" }, { status: 400 });
    }

    if (rows.length > 500) {
      return NextResponse.json({ error: "Max 500 rows per import" }, { status: 400 });
    }

    let inserted = 0;
    let skipped = 0;
    const errors: Array<{ line: number; name: string; error: string }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const name = (r.display_name || "").trim();

      if (!name) {
        skipped++;
        continue;
      }

      // Normalize / validate
      const category = VALID_CATEGORIES.has(r.category) ? r.category : "other";
      const tier = VALID_TIERS.has(r.tier) ? (r.tier || null) : null;
      const client_type = VALID_CLIENT_TYPES.has(r.client_type) ? (r.client_type || null) : null;
      const email = (r.email || "").trim() || null;
      const phone = (r.phone || "").trim() || null;
      const company = (r.company || "").trim() || null;
      const notes = (r.notes || "").trim() || null;

      // Check for duplicate by name + user_id
      const { data: existing } = await supabaseAdmin
        .from("contacts")
        .select("id")
        .eq("user_id", uid)
        .ilike("display_name", name)
        .limit(1);

      if ((existing ?? []).length > 0) {
        skipped++;
        continue;
      }

      const { error: insErr } = await supabaseAdmin.from("contacts").insert({
        user_id: uid,
        display_name: name,
        category,
        tier,
        client_type,
        email,
        phone,
        company,
        notes,
        archived: false,
      });

      if (insErr) {
        errors.push({ line: i + 2, name, error: insErr.message });
        skipped++;
      } else {
        inserted++;
      }
    }

    return NextResponse.json({ ok: true, inserted, skipped, errors });
  } catch (e) {
    return serverError("CONTACTS_IMPORT_CRASH", e);
  }
}
