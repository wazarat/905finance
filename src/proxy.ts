import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/server/auth/session";

/**
 * Optimistic redirect for signed-out visitors to protected areas.
 *
 * This only checks that a session cookie is present so people are sent to the
 * login screen quickly. It is not the security boundary: every protected page
 * and every data-layer function verifies the session and permissions itself.
 */
export function proxy(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.next();
  }
  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/projects/:path*",
    "/seller/:path*",
    "/engagements/:path*",
    "/wallets/:path*",
    "/settings/:path*",
    "/onboarding/:path*",
  ],
};
