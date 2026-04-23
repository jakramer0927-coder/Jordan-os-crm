import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

const GEOCODE_API = "https://maps.googleapis.com/maps/api/geocode/json";

function extractComponent(components: any[], type: string): string | null {
  return components.find((c: any) => c.types.includes(type))?.long_name ?? null;
}

async function geocodeNeighborhood(address: string): Promise<string | null> {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  const url = `${GEOCODE_API}?address=${encodeURIComponent(address)}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const j = await res.json();
  const comps: any[] = j.results?.[0]?.address_components ?? [];
  return (
    extractComponent(comps, "neighborhood") ??
    extractComponent(comps, "sublocality_level_1") ??
    extractComponent(comps, "sublocality") ??
    null
  );
}

// POST /api/pipeline/backfill-neighborhoods
// Geocodes all deals with a non-null address but null neighborhood and updates the DB.
export async function POST(req: Request) {
  try {
    const uid = await getVerifiedUid();
    if (!uid) return unauthorized();

    const { data: deals, error } = await supabaseAdmin
      .from("deals")
      .select("id, address")
      .eq("user_id", uid)
      .not("address", "is", null)
      .neq("address", "")
      .is("neighborhood", null);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!deals?.length) return NextResponse.json({ updated: 0, message: "Nothing to backfill" });

    let updated = 0;
    let failed = 0;
    for (const deal of deals) {
      const neighborhood = await geocodeNeighborhood(deal.address!);
      if (neighborhood) {
        await supabaseAdmin.from("deals").update({ neighborhood }).eq("id", deal.id).eq("user_id", uid);
        updated++;
      } else {
        failed++;
      }
      // Stay well under Google's rate limit
      await new Promise(r => setTimeout(r, 120));
    }

    return NextResponse.json({ updated, failed, total: deals.length });
  } catch (e) {
    return serverError("BACKFILL_NEIGHBORHOODS_CRASH", e);
  }
}
