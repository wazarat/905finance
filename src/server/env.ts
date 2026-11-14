/**
 * Server-side environment access. Values are read lazily so that importing a
 * module never fails at build time because a secret is absent.
 */

const MIN_SECRET_LENGTH = 32;

export function sessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters. See .env.example.`,
    );
  }
  return new TextEncoder().encode(secret);
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
