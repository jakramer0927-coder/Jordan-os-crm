import { NextResponse } from "next/server";
import { parse } from "csv-parse/sync";
import { google } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function normName(v: unknown): string {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return s.replace(/\s+/g, " ").trim();
}

function normEmail(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!s) return null;
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  return ok ? s : null;
}

function parseEmailList(v: unknown): string[] {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  if (!s) return [];
  const matches = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return Array.from(new Set((matches ?? []).map((e) => e.toLowerCase().trim()))).filter(Boolean);
}

function normPhone(v: unknown): string | null {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length < 10) return null;
  return digits;
}

function splitGroups(v: unknown): string[] {
  const s = typeof v === "string" ? v : v == null ? "" : String(v);
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function pickFirstStr(...vals: (unknown | null | undefined)[]): string | null {
  for (const v of vals) {
    const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
    if (s) return s;
  }
  return null;
}

function buildPrimaryAddress(row: Record<string, any>): string | null {
  const l1 = String(row["Primary Address Line 1"] || "").trim();
  const l2 = String(row["Primary Address Line 2"] || "").trim();
  const city = String(row["Primary Address City"] || "").trim();
  const st = String(row["Primary Address State"] || "").trim();
  const zip = String(row["Primary Address Zip"] || "").trim();

  const parts = [l1, l2, [city, st, zip].filter(Boolean).join(" ")].filter(Boolean);
  if (!parts.length) return null;
  return parts.join(", ");
}

function appendNotes(existing: string | null, compassNotes: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const block = `\n\n---\nCompass import (${stamp})\n${compassNotes.trim()}`;
  if (!existing || !existing.trim()) return block.trim();
  if (existing.includes(compassNotes.trim())) return existing;
  return (existing + block).trim();
}

async function getAgentAllowListFromMasterSheet(uid: string): Promise<Set<string>> {
  const { data: settings, error: sErr } = await supabaseAdmin
    .from("user_settings")
    .select("sheet_url")
    .eq("user_id", uid)
    .maybeSingle();

  if (sErr) throw new Error(sErr.message);

  const sheetUrl = (settings?.sheet_url || "").trim();
  if (!sheetUrl)
    throw new Error("Missing sheet_url in user_settings. Save it on Integrations page first.");

  const m = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const spreadsheetId = m ? m[1] : null;
  if (!spreadsheetId) throw new Error("Could not parse spreadsheetId from sheet_url.");

  const { data: tok } = await supabaseAdmin
    .from("google_tokens")
    .select("access_token, refresh_token, expiry_date")
    .eq("user_id", uid)
    .single();

  if (!tok?.refresh_token) throw new Error("Google not connected (missing refresh token).");

  const oauth2 = getGoogleOAuthClient();
  oauth2.setCredentials({
    access_token: tok.access_token ?? undefined,
    refresh_token: tok.refresh_token ?? undefined,
    expiry_date: tok.expiry_date ?? undefined,
  });

  const sheets = google.sheets({ version: "v4", auth: oauth2 });
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const firstTitle = meta.data.sheets?.[0]?.properties?.title;
  if (!firstTitle) throw new Error("Master sheet has no tabs.");

  const range = `'${firstTitle}'!A:Z`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "FORMATTED_STRING",
  });

  const rows = (res.data.values || []) as any[][];
  if (rows.length < 2) return new Set();

  const header = rows[0].map((h) => String(h || "").trim());
  const idxName = header.findIndex((h) => h.toLowerCase() === "name");
  const idxCat = header.findIndex((h) => h.toLowerCase() === "category (client/agent/developer)");

  if (idxName === -1 || idxCat === -1) {
    throw new Error(
      "Master sheet is missing required columns: Name and Category (Client/Agent/Developer).",
    );
  }

  const allow = new Set<string>();
  for (const r of rows.slice(1)) {
    const name = normName(r[idxName]);
    const cat = String(r[idxCat] || "")
      .trim()
      .toLowerCase();
    if (name && cat === "agent") allow.add(name.toLowerCase());
  }
  return allow;
}

function extractEmailsFromRow(row: Record<string, any>): string[] {
  const out = new Set<string>();

  // 1) Any column whose header contains "email"
  for (const k of Object.keys(row)) {
    if (k && k.toLowerCase().includes("email")) {
      for (const e of parseEmailList(row[k])) out.add(e);
    }
  }

  // 2) ANY email pattern found anywhere in the row values (belt + suspenders)
  for (const k of Object.keys(row)) {
    const v = row[k];
    for (const e of parseEmailList(v)) out.add(e);
  }

  return Array.from(out);
}

function pickPrimaryEmail(row: Record<string, any>, all: string[]): string | null {
  const preferred = [
    row["Primary Email"],
    row["Primary Work Email"],
    row["Primary Personal Email"],
    row["Work Email"],
    row["Personal Email"],
    row["Email"],
  ]
    .map(normEmail)
    .filter(Boolean) as string[];

  for (const e of preferred) if (e) return e;
  return all.length ? all[0] : null;
}

async function insertContactEmail(contactId: string, email: string, isPrimary: boolean) {
  const { error } = await supabaseAdmin.from("contact_emails").insert({
    contact_id: contactId,
    email,
    is_primary: isPrimary,
    source: "compass_import",
  });

  // ignore duplicates
  if (
    error &&
    !String(error.message || "")
      .toLowerCase()
      .includes("duplicate")
  ) {
    throw error;
  }

  return !error; // true if inserted
}

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const uid = url.searchParams.get("uid") || "";
    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File))
      return NextResponse.json({ error: "Missing file" }, { status: 400 });

    const csvText = await file.text();

    const records = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
      trim: true,
    }) as Record<string, any>[];

    const allowedAgents = await getAgentAllowListFromMasterSheet(uid);

    const includeGroups = new Set([
      "Active clients",
      "Past clients",
      "Leads",
      "Sphere of influence",
      "Vendors",
    ]);

    let scanned = 0;
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let agentsSkipped = 0;

    let emailsInserted = 0;

    for (const row of records) {
      scanned += 1;

      const fullName = normName(
        row["Name"] || `${row["First Name"] || ""} ${row["Last Name"] || ""}`,
      );
      if (!fullName) {
        skipped += 1;
        continue;
      }

      const groups = splitGroups(row["Groups"]);
      const isAgent = groups.includes("Agents");

      if (isAgent) {
        if (!allowedAgents.has(fullName.toLowerCase())) {
          agentsSkipped += 1;
          continue;
        }
      } else {
        const ok = groups.some((g) => includeGroups.has(g));
        if (!ok) {
          skipped += 1;
          continue;
        }
      }

      // Category + client_type
      let category = "Other";
      let client_type: string | null = null;

      if (isAgent) {
        category = "Agent";
      } else if (groups.includes("Vendors")) {
        category = "Vendor";
      } else {
        category = "Client";
        if (groups.includes("Active clients")) client_type = "active_client";
        else if (groups.includes("Past clients")) client_type = "past_client";
        else if (groups.includes("Leads")) client_type = "lead";
        else if (groups.includes("Sphere of influence")) client_type = "sphere";
      }

      const allEmails = extractEmailsFromRow(row);
      const primaryEmail = pickPrimaryEmail(row, allEmails);

      const phone = normPhone(
        pickFirstStr(
          row["Primary Mobile Phone"],
          row["Mobile Phone"],
          row["Primary Work Phone"],
          row["Work Phone"],
          row["Phone"],
        ),
      );

      const company = pickFirstStr(row["Company"]);
      const address_primary = buildPrimaryAddress(row);

      const compassNotesRaw = [
        row["Key Background Info"]
          ? `Key Background Info: ${String(row["Key Background Info"]).trim()}`
          : "",
        row["Tags"] ? `Tags: ${String(row["Tags"]).trim()}` : "",
        row["Status"] ? `Compass Status: ${String(row["Status"]).trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      // Find existing contact by name+category
      const { data: existing } = await supabaseAdmin
        .from("contacts")
        .select("id, notes")
        .ilike("display_name", fullName)
        .ilike("category", category)
        .maybeSingle();

      const upsertEmails = async (contactId: string) => {
        for (const e of allEmails) {
          const didInsert = await insertContactEmail(
            contactId,
            e,
            !!primaryEmail && e === primaryEmail,
          );
          if (didInsert) emailsInserted += 1;
        }
      };

      if (existing?.id) {
        const nextNotes = compassNotesRaw.trim()
          ? appendNotes(existing.notes ?? null, compassNotesRaw)
          : (existing.notes ?? null);

        const { error: updErr } = await supabaseAdmin
          .from("contacts")
          .update({
            client_type,
            email: primaryEmail ?? undefined,
            phone: phone ?? undefined,
            company: company ?? undefined,
            address_primary,
            notes: nextNotes,
            source_compass_name: fullName,
          })
          .eq("id", existing.id);

        if (updErr) {
          skipped += 1;
          continue;
        }

        await upsertEmails(existing.id);

        updated += 1;
        continue;
      }

      // Insert new contact
      const baseNotes = compassNotesRaw.trim() ? appendNotes(null, compassNotesRaw) : null;

      const { data: ins, error: insErr } = await supabaseAdmin
        .from("contacts")
        .insert({
          display_name: fullName,
          category,
          client_type,
          tier: null,
          email: primaryEmail,
          phone,
          company,
          address_primary,
          notes: baseNotes,
          source_compass_name: fullName,
        })
        .select("id")
        .single();

      if (insErr || !ins?.id) {
        skipped += 1;
        continue;
      }

      await upsertEmails(ins.id);

      imported += 1;
    }

    return NextResponse.json({
      scanned,
      imported,
      updated,
      skipped,
      agentsSkipped,
      allowedAgents: allowedAgents.size,
      emailsInserted,
    });
  } catch (e: any) {
    console.error("COMPASS_IMPORT_ERROR", e?.message || e);
    return NextResponse.json(
      { error: "Compass CSV import failed", details: String(e?.message || e) },
      { status: 500 },
    );
  }
}
