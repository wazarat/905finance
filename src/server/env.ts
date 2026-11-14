/**
 * Server-side environment access. Values are read lazily so that importing a
 * module never fails at build time because a secret is absent.
 */

const MIN_SECRET_LENGTH = 32;

/** The session signing key, or null when it is missing or too short. */
export function sessionSecretOrNull(): Uint8Array | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return null;
  return new TextEncoder().encode(secret);
}

/** The session signing key. Throws when it is not configured: used when issuing sessions. */
export function sessionSecret(): Uint8Array {
  const secret = sessionSecretOrNull();
  if (!secret) {
    throw new Error(
      `SESSION_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters. See .env.example.`,
    );
  }
  return secret;
}

/**
 * The shared secret testing workers present. Null when it is missing or too
 * short, in which case the worker endpoints refuse every request.
 */
export function workerToken(): string | null {
  const token = process.env.WORKER_TOKEN;
  return token && token.length >= MIN_SECRET_LENGTH ? token : null;
}

export type PrivyServerConfig = { appId: string; appSecret: string };

export function privyServerConfig(): PrivyServerConfig | null {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Development sign-in is available only when explicitly requested AND the
 * process is not a production build. Both conditions are required.
 */
export function isDevAuthEnabled(): boolean {
  return process.env.AUTH_MODE === "dev" && !isProduction();
}

/** Raised at server start so a misconfigured production deployment fails loudly. */
export function assertSafeAuthConfiguration(): void {
  if (process.env.AUTH_MODE === "dev" && isProduction()) {
    throw new Error(
      "AUTH_MODE=dev is not permitted in production. Remove it and configure Privy credentials.",
    );
  }
}

/** Required settings that are absent, described for an operator reading the server log. */
export function missingConfiguration(): string[] {
  const missing: string[] = [];
  if (!process.env.DATABASE_URL) {
    missing.push("DATABASE_URL (PostgreSQL connection string): pages that read data will fail");
  }
  if (!sessionSecretOrNull()) {
    missing.push(
      `SESSION_SECRET (at least ${MIN_SECRET_LENGTH} random characters): nobody can sign in`,
    );
  }
  if (!privyServerConfig()) {
    missing.push("NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET: Privy sign-in is unavailable");
  }
  return missing;
}
