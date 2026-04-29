import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { createSupabaseServerClient, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

type LinkedInRow = {
  first_name: string;
  last_name: string;
  email: string;
  company: string;
  position: string;
  connected_on: string;
};

type MatchResult = {
  contact_id: string;
  display_name: string;
  linkedin_name: string;
  match_type: "email" | "name";
  connected_on: string | null;
  company: string;
  position: string;
};

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "").trim();
}

function parseConnectedOn(s: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export async function POST(req: Request) {
  try {
    const serverClient = await createSupabaseServerClient();
    const { data: { session } } = await serverClient.auth.getSession();
    const uid = session?.user?.id ?? null;
    if (!uid) return unauthorized();

    const body = await req.json();
    const rows: LinkedInRow[] = body.rows ?? [];
    const apply: boolean = body.apply ?? false;

    const { data: contacts } = await supabaseAdmin
      .from("contacts")
      .select("id, display_name, email")
      .eq("user_id", uid)
      .eq("archived", false);

    const allContacts = contacts ?? [];

    const emailIndex: Record<string, string> = {};
    const nameIndex: Record<string, string> = {};
    for (const c of allContacts) {
      if (c.email) emailIndex[c.email.toLowerCase().trim()] = c.id;
      const normalized = normalizeName(c.display_name);
      if (normalized) nameIndex[normalized] = c.id;
    }

    const matched: MatchResult[] = [];
    const unmatched: { linkedin_name: string; email: string; company: string; position: string }[] = [];
    const seenContactIds = new Set<string>();

    for (const row of rows) {
      const fullName = `${row.first_name} ${row.last_name}`.trim();
      if (!fullName) continue;

      const connectedOn = parseConnectedOn(row.connected_on);
      const emailKey = (row.email || "").toLowerCase().trim();

      let contactId: string | null = null;
      let matchType: "email" | "name" = "name";

      if (emailKey && emailIndex[emailKey]) {
        contactId = emailIndex[emailKey];
        matchType = "email";
      } else {
        const normalizedLinkedIn = normalizeName(fullName);
        if (normalizedLinkedIn && nameIndex[normalizedLinkedIn]) {
          contactId = nameIndex[normalizedLinkedIn];
          matchType = "name";
        }
      }

      if (contactId && !seenContactIds.has(contactId)) {
        seenContactIds.add(contactId);
        const contact = allContacts.find(c => c.id === contactId);
        matched.push({
          contact_id: contactId,
          display_name: contact?.display_name ?? fullName,
          linkedin_name: fullName,
          match_type: matchType,
          connected_on: connectedOn,
          company: row.company,
          position: row.position,
        });
      } else if (!contactId) {
        unmatched.push({ linkedin_name: fullName, email: row.email, company: row.company, position: row.position });
      }
    }

    if (apply) {
      await Promise.all(
        matched.map(m =>
          supabaseAdmin
            .from("contacts")
            .update({ linkedin_connected_at: m.connected_on ?? new Date().toISOString().slice(0, 10) })
            .eq("id", m.contact_id)
        )
      );
      return NextResponse.json({ applied: matched.length });
    }

    return NextResponse.json({
      total: rows.length,
      matched: matched.length,
      unmatched: unmatched.length,
      matchedContacts: matched.slice(0, 200),
      unmatchedContacts: unmatched.slice(0, 100),
    });
  } catch (e) {
    return serverError("LINKEDIN_IMPORT_CRASH", e);
  }
}
