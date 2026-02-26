import { NextResponse } from "next/server";
import { google } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getGoogleOAuthClient } from "@/lib/google";

export const runtime = "nodejs";

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function extractSpreadsheetId(sheetUrl: string): string | null {
  const m = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

function safeStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function normName(v: unknown): string {
  const s = safeStr(v);
  return s.replace(/\s+/g, " ").trim();
}

function normCategory(v: unknown): string {
  const s = safeStr(v);
  if (!s) return "Other";
  // preserve your canonical casing, but normalize for comparisons elsewhere
  return s.replace(/\s+/g, " ").trim();
}

function parseDateLoose(v: unknown): Date | null {
  if (v == null) return null;

  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d;
  }

  if (typeof v === "number") {
    // Google Sheets serial date (days since 1899-12-30)
    const base = new Date(Date.UTC(1899, 11, 30));
    base.setUTCDate(base.getUTCDate() + v);
    if (!isNaN(base.getTime())) return base;
  }

  return null;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const uid = url.searchParams.get("uid") || "";
    if (!isUuid(uid)) return NextResponse.json({ error: "Invalid uid" }, { status: 400 });

    // Load user settings to get sheet_url
    const { data: settings, error: setErr } = await supabaseAdmin
      .from("user_settings")
      .select("sheet_url")
      .eq("user_id", uid)
      .maybeSingle();

    if (setErr) return NextResponse.json({ error: setErr.message }, { status: 500 });

    const sheetUrl = (settings?.sheet_url || "").trim();
    if (!sheetUrl) return NextResponse.json({ error: "No sheet_url saved in settings." }, { status: 400 });

    const spreadsheetId = extractSpreadsheetId(sheetUrl);
    if (!spreadsheetId) return NextResponse.json({ error: "Could not parse spreadsheet ID from sheet_url." }, { status: 400 });

    // Get Google tokens
    const { data: tok, error: tokErr } = await supabaseAdmin
      .from("google_tokens")
      .select("access_token, refresh_token, expiry_date")
      .eq("user_id", uid)
      .single();

    if (tokErr || !tok) return NextResponse.json({ error: "Google not connected" }, { status: 400 });
    if (!tok.refresh_token) return NextResponse.json({ error: "Missing refresh token (reconnect Google)" }, { status: 400 });

    const oauth2 = getGoogleOAuthClient();
    oauth2.setCredentials({
      access_token: tok.access_token ?? undefined,
      refresh_token: tok.refresh_token ?? undefined,
      expiry_date: tok.expiry_date ?? undefined,
    });

    const sheets = google.sheets({ version: "v4", auth: oauth2 });

    // Read first tab
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const firstSheetTitle = meta.data.sheets?.[0]?.properties?.title;
    if (!firstSheetTitle) return NextResponse.json({ error: "Spreadsheet has no sheets/tabs." }, { status: 400 });

    const range = `'${firstSheetTitle}'!A:Z`;
    const valuesRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
      valueRenderOption: "UNFORMATTED_VALUE",
      dateTimeRenderOption: "FORMATTED_STRING",
    });

    const rows = (valuesRes.data.values || []) as any[][];
    if (rows.length < 2) return NextResponse.json({ error: "Sheet has no data rows." }, { status: 400 });

    const header = rows[0].map((h) => safeStr(h));
    const dataRows = rows.slice(1);

    const idx = (col: string) => header.findIndex((h) => h.toLowerCase() === col.toLowerCase());

    const iName = idx("Name");
    const iCategory = idx("Category (Client/Agent/Developer)");
    const iClientType = idx("Client Type");
    const iTier = idx("Tier (A/B/C)");
    const iLastContact = idx("Last Contact Date");

    if (iName === -1) return NextResponse.json({ error: "Missing required column: Name" }, { status: 400 });
    if (iCategory === -1) return NextResponse.json({ error: "Missing required column: Category (Client/Agent/Developer)" }, { status: 400 });
    if (iTier === -1) return NextResponse.json({ error: "Missing required column: Tier (A/B/C)" }, { status: 400 });

    let upserted = 0;
    let skipped = 0;
    let touchesCreated = 0;
    let duplicatesAvoided = 0;

    for (const r of dataRows) {
      const name = normName(r[iName]);
      if (!name) {
        skipped += 1;
        continue;
      }

      const category = normCategory(r[iCategory]) || "Other";

      const tierRaw = safeStr(r[iTier]).toUpperCase();
      const tier = tierRaw === "A" || tierRaw === "B" || tierRaw === "C" ? tierRaw : null;

      const clientType = iClientType !== -1 ? safeStr(r[iClientType]) : "";

      // Find existing by (display_name + category), case-insensitive
      const { data: existing, error: findErr } = await supabaseAdmin
        .from("contacts")
        .select("id, display_name, category")
        .ilike("display_name", name)
        .ilike("category", category)
        .maybeSingle();

      if (findErr) {
        skipped += 1;
        continue;
      }

      let contactId: string | null = existing?.id ?? null;

      if (contactId) {
        // Update existing
        const { error: updErr } = await supabaseAdmin
          .from("contacts")
          .update({
            display_name: name,
            category,
            tier,
            client_type: clientType ? clientType : null,
          })
          .eq("id", contactId);

        if (updErr) {
          skipped += 1;
          continue;
        }
      } else {
        // Insert new (unique index prevents duplicates)
        const { data: ins, error: insErr } = await supabaseAdmin
          .from("contacts")
          .insert({
            display_name: name,
            category,
            tier,
            client_type: clientType ? clientType : null,
          })
          .select("id")
          .single();

        if (insErr) {
          // If unique constraint triggers, it means a near-duplicate exists (case diff, etc.)
          duplicatesAvoided += 1;
          // Try to re-select exact match after conflict
          const { data: ex2 } = await supabaseAdmin
            .from("contacts")
            .select("id")
            .ilike("display_name", name)
            .ilike("category", category)
            .maybeSingle();
          contactId = ex2?.id ?? null;

          if (!contactId) {
            skipped += 1;
            continue;
          }
        } else {
          contactId = ins?.id ?? null;
        }
      }

      upserted += 1;

      // Create a "sheet_import" touch from Last Contact Date (if present)
      if (contactId && iLastContact !== -1) {
        const d = parseDateLoose(r[iLastContact]);
        if (d) {
          const occurredAt = d.toISOString();

          // Dedupe touch
          const { data: exTouch } = await supabaseAdmin
            .from("touches")
            .select("id")
            .eq("contact_id", contactId)
            .eq("source", "sheet_import")
            .eq("occurred_at", occurredAt)
            .limit(1);

          if ((exTouch ?? []).length === 0) {
            const { error: tErr } = await supabaseAdmin.from("touches").insert({
              contact_id: contactId,
              channel: "other",
              direction: "outbound",
              occurred_at: occurredAt,
              intent: "check_in",
              summary: "Imported last contact date from master sheet",
              source: "sheet_import",
              source_link: sheetUrl,
            });

            if (!tErr) touchesCreated += 1;
          }
        }
      }
    }

    return NextResponse.json({
      upserted,
      skipped,
      touchesCreated,
      duplicatesAvoided,
      sheet: firstSheetTitle,
    });
  } catch (e: any) {
    console.error("SHEETS_IMPORT_ERROR", e?.message || e);
    return NextResponse.json({ error: "Sheets import failed", details: String(e?.message || e) }, { status: 500 });
  }
}