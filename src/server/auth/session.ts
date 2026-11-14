import { SignJWT, jwtVerify } from "jose";

/**
 * Application session token: a short-lived signed JWT stored in an HttpOnly
 * cookie. It is only ever issued after the identity provider's access token
 * has been verified on the server (or, in development, by the dev sign-in).
 */

export const SESSION_COOKIE = "nof_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

const ISSUER = "905finance";
const AUDIENCE = "905finance:session";

export type SessionSource = "privy" | "dev";

export type SessionClaims = {
  userId: string;
  source: SessionSource;
};

export async function createSessionToken(
  claims: SessionClaims,
  secret: Uint8Array,
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ src: claims.source })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(secret);
}

/** Returns the claims for a valid token, or null for anything else. */
export async function readSessionToken(
  token: string | undefined | null,
  secret: Uint8Array,
): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });
    const source = payload.src;
    if (typeof payload.sub !== "string" || (source !== "privy" && source !== "dev")) {
      return null;
    }
    return { userId: payload.sub, source };
  } catch {
    return null;
  }
}
