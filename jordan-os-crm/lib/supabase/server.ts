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

export async function getVerifiedUser(): Promise<{ id: string; email: string | null; name: string | null } | null> {
  try {
    const client = await createSupabaseServerClient();
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user) return null;
    const name = (user.user_metadata?.full_name as string | undefined) ?? null;
    return { id: user.id, email: user.email ?? null, name };
  } catch {
    return null;
  }
}

/** Standard 401 response. */
export function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Returns a safe 500 response.
 * In production, never exposes stack traces or internal details to the client.
 * In development, includes full error details for debugging.
 */
export function serverError(label: string, e: unknown) {
  const anyE = e as { message?: unknown; name?: unknown; stack?: unknown };
  const message = String(anyE?.message || e || "Unknown error");
  console.error(`[${label}]`, message, anyE?.stack ?? "");

  if (process.env.NODE_ENV !== "production") {
    return NextResponse.json(
      {
        error: message,
        details: {
          name: String(anyE?.name || ""),
          stack: typeof anyE?.stack === "string" ? anyE.stack.split("\n").slice(0, 12).join("\n") : "",
        },
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ error: "An unexpected error occurred" }, { status: 500 });
}
