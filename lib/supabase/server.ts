import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set() {
          // no-op in server components
        },
        remove() {
          // no-op in server components
        },
      },
    },
  );
}

/**
 * Reads the verified user ID from the session cookie.
 * Never trusts uid from request body/query strings.
 * Returns null if unauthenticated.
 */
export async function getVerifiedUid(): Promise<string | null> {
  try {
    const client = await createSupabaseServerClient();
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user) return null;
    return user.id;
  } catch {
    return null;
  }
}

/** Standard 401 response. */
export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
