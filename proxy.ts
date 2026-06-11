import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

export default async function proxy(req: NextRequest) {
  const res = NextResponse.next();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            res.cookies.set(name, value, options);
          });
        },
      },
    },
  );

  const path = req.nextUrl.pathname;

  // Vercel cron invocations carry no session cookie — they authenticate inside
  // the route handler via CRON_SECRET. Redirecting them to /login silently
  // disables every scheduled job, so let them through untouched.
  if (path.startsWith("/api/cron")) {
    return res;
  }

  const { data } = await supabase.auth.getSession();
  const session = data.session;

  const isLogin = path.startsWith("/login");
  const isAuth = path.startsWith("/auth");

  if (!session && !isLogin && !isAuth) {
    // API callers need a 401 they can handle, not a redirect to an HTML page
    if (path.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next|favicon.ico).*)"],
};
