import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { CookieOptions } from "@supabase/ssr";

export const runtime = "nodejs";

function getBaseUrl(req: Request) {
  // Prefer your configured public base URL (Vercel)
  const env = process.env.APP_BASE_URL;
  if (env && env.startsWith("http")) return env;

  // Fallback to request origin
  const url = new URL(req.url);
  return url.origin;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");

  const baseUrl = getBaseUrl(req);

  // If no code, bounce to login (or show a message)
  if (!code) {
    return NextResponse.redirect(`${baseUrl}/login`);
  }

  // We must set cookies on the response (SSR PKCE flow)
  const res = NextResponse.redirect(`${baseUrl}/contacts`);

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return req.headers.get("cookie")?.match(new RegExp(`${name}=([^;]+)`))?.[1];
        },
        set(name: string, value: string, options: CookieOptions) {
          res.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          res.cookies.set({ name, value: "", ...options, maxAge: 0 });
        },
      },
    }
  );

  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // If exchange fails, send back to login with a hint
    return NextResponse.redirect(`${baseUrl}/login?e=callback_exchange_failed`);
  }

  return res;
}