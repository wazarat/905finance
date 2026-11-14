import { NextResponse, type NextRequest } from "next/server";
import { startSession } from "@/server/auth/actor";
import { getTokenVerifier } from "@/server/auth/config";
import { signInWithAccessToken } from "@/server/auth/identity";
import { isAppError } from "@/server/errors";

/**
 * Exchanges a Privy access token for an application session.
 *
 * The token arrives in the Authorization header and is verified server-side
 * against Privy's keys. The request body is ignored: no user id, role or
 * organization supplied by the browser is ever trusted.
 */
export async function POST(request: NextRequest) {
  const verifier = getTokenVerifier();
  if (!verifier) {
    return NextResponse.json({ error: "Sign-in is not configured." }, { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;

  try {
    const user = await signInWithAccessToken(verifier, token);
    await startSession(user.id, "privy");
    return NextResponse.json({ ok: true, onboarded: user.onboardedAt !== null });
  } catch (error) {
    if (isAppError(error)) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    console.error("Session exchange failed", error);
    return NextResponse.json({ error: "Sign-in failed." }, { status: 500 });
  }
}
