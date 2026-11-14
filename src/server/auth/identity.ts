import "server-only";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { User } from "@/db/schema";
import { invalid } from "../errors";
import type { TokenVerifier, VerifiedIdentity } from "./verifier";

const { users } = schema;

/**
 * Find or create the user row for a verified identity. The provider subject is
 * the only key; profile fields are filled in when first seen and never
 * overwrite values the user has since edited.
 */
export async function upsertUserFromIdentity(identity: VerifiedIdentity): Promise<User> {
  const db = getDb();
  const [inserted] = await db
    .insert(users)
    .values({
      privyUserId: identity.subject,
      email: identity.email,
      displayName: identity.displayName,
    })
    .onConflictDoNothing({ target: users.privyUserId })
    .returning();
  if (inserted) return inserted;

  const [existing] = await db.select().from(users).where(eq(users.privyUserId, identity.subject));
  if (!existing) {
    throw new Error("User row disappeared during sign-in.");
  }
  if (!existing.email && identity.email) {
    const [updated] = await db
      .update(users)
      .set({ email: identity.email })
      .where(eq(users.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  return existing;
}

/**
 * Exchange an identity-provider access token for a user. The token is verified
 * server-side; nothing else supplied by the client is trusted.
 */
export async function signInWithAccessToken(
  verifier: TokenVerifier,
  accessToken: string | null | undefined,
): Promise<User> {
  if (!accessToken || accessToken.length > 8192) {
    throw invalid("Missing access token.");
  }
  let identity: VerifiedIdentity;
  try {
    identity = await verifier.verify(accessToken);
  } catch {
    throw invalid("The access token could not be verified.");
  }
  if (!identity.subject) {
    throw invalid("The access token could not be verified.");
  }
  return upsertUserFromIdentity(identity);
}

const DEV_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Development sign-in: derives a stable local identity from an email address. */
export function devIdentityForEmail(rawEmail: string): VerifiedIdentity {
  const email = rawEmail.trim().toLowerCase();
  if (!DEV_EMAIL_PATTERN.test(email) || email.length > 254) {
    throw invalid("Enter a valid email address.", { email: ["Enter a valid email address."] });
  }
  return { subject: `dev:${email}`, email, displayName: null };
}
