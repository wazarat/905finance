import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { User } from "@/db/schema";
import type { Actor } from "../authz";
import { isProduction, sessionSecret, sessionSecretOrNull } from "../env";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionToken,
  readSessionToken,
  type SessionSource,
} from "./session";

let warnedAboutMissingSecret = false;

/**
 * The signed-in user for this request, or null. The session cookie is verified
 * and the user is re-read from the database on every request, so a deleted
 * user loses access immediately.
 *
 * Visitors without a session cookie are signed out by definition, so nothing
 * else is consulted for them. If the signing key is not configured, no session
 * can be valid: every visitor is treated as signed out rather than the page
 * failing, and the problem is reported in the server log.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const secret = sessionSecretOrNull();
  if (!secret) {
    if (!warnedAboutMissingSecret) {
      warnedAboutMissingSecret = true;
      console.error("SESSION_SECRET is not configured; all visitors are treated as signed out.");
    }
    return null;
  }

  const claims = await readSessionToken(token, secret);
  if (!claims) return null;
  const [user] = await getDb()
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, claims.userId));
  return user ?? null;
});

export async function getActor(): Promise<Actor | null> {
  const user = await getCurrentUser();
  return user ? { userId: user.id } : null;
}

/** For pages: the signed-in user, or a redirect to the login screen. */
export async function requireUser(nextPath?: string): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    redirect(nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : "/login");
  }
  return user;
}

export async function startSession(userId: string, source: SessionSource): Promise<void> {
  const token = await createSessionToken({ userId, source }, sessionSecret());
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
