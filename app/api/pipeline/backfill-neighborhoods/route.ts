import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getVerifiedUid, unauthorized, serverError } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Zip → neighborhood for generic "Los Angeles" addresses
const LA_ZIP_NEIGHBORHOODS: Record<string, string> = {
  "90004": "Koreatown", "90005": "Koreatown", "90006": "Koreatown",
  "90012": "Downtown LA", "90013": "Downtown LA", "90014": "Downtown LA", "90015": "Downtown LA",
  "90016": "West Adams", "90017": "Westlake",
  "90019": "Mid-City", "90020": "Hancock Park", "90024": "Westwood",
  "90025": "West LA", "90026": "Silver Lake", "90027": "Los Feliz",
  "90028": "Hollywood", "90029": "East Hollywood", "90031": "Lincoln Heights",
  "90032": "El Sereno", "90034": "Palms", "90035": "Beverlywood",
  "90036": "Fairfax", "90038": "Hollywood", "90039": "Atwater Village",
  "90041": "Eagle Rock", "90042": "Highland Park", "90043": "Leimert Park",
  "90044": "South LA", "90045": "Westchester", "90046": "West Hollywood Hills",
  "90047": "South LA", "90048": "West Hollywood", "90049": "Brentwood",
  "90056": "Ladera Heights", "90057": "Westlake", "90064": "Rancho Park",
  "90065": "Mt Washington", "90066": "Mar Vista", "90067": "Century City",
  "90068": "Hollywood Hills", "90069": "West Hollywood", "90071": "Downtown LA",
  "90073": "Brentwood", "90077": "Bel Air", "90094": "Playa Vista",
  "90210": "Beverly Hills", "90211": "Beverly Hills", "90212": "Beverly Hills",
  "90230": "Culver City", "90232": "Culver City", "90272": "Pacific Palisades",
  "90291": "Venice", "90292": "Marina del Rey", "90293": "Playa del Rey",
  "90401": "Santa Monica", "90402": "Santa Monica", "90403": "Santa Monica",
  "90404": "Santa Monica", "90405": "Santa Monica",
};

// Google Places Autocomplete produces addresses like:
//   "123 Main St, Sherman Oaks, CA 91423, USA"
//   "456 Ocean Ave, Santa Monica, CA 90401, USA"
// The city/neighborhood is always parts[1].
function parseNeighborhoodFromAddress(address: string): string | null {
  const parts = address.split(",").map(s => s.trim());
  if (parts.length < 2) return null;
  const city = parts[1];
  if (!city || city === "USA") return null;
  if (city !== "Los Angeles") return city;
  // For unincorporated LA, resolve via zip code
  const zipMatch = address.match(/\b(\d{5})\b/);
  if (zipMatch) return LA_ZIP_NEIGHBORHOODS[zipMatch[1]] ?? null;
  return null;
}

// POST /api/pipeline/backfill-neighborhoods
// Fills neighborhood for all deals that have an address but no neighborhood.
// Parses city from the Google Places address string — no geocoding API call needed.
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
      const neighborhood = parseNeighborhoodFromAddress(deal.address!);
      if (neighborhood) {
        await supabaseAdmin.from("deals").update({ neighborhood }).eq("id", deal.id).eq("user_id", uid);
        updated++;
      } else {
        failed++;
      }
    }

    return NextResponse.json({ updated, failed, total: deals.length, message: `Updated ${updated} of ${deals.length} deals` });
  } catch (e) {
    return serverError("BACKFILL_NEIGHBORHOODS_CRASH", e);
  }
}
