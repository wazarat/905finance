import "server-only";
import { isDevAuthEnabled, privyServerConfig } from "../env";
import { PrivyTokenVerifier, type TokenVerifier } from "./verifier";

let verifier: TokenVerifier | null | undefined;

/** The identity-provider token verifier, or null when Privy is not configured. */
export function getTokenVerifier(): TokenVerifier | null {
  if (verifier === undefined) {
    const config = privyServerConfig();
    verifier = config ? new PrivyTokenVerifier(config) : null;
  }
  return verifier;
}

export type AuthAvailability = {
  /** Public Privy app id when Privy sign-in is fully configured, else null. */
  privyAppId: string | null;
  devSignIn: boolean;
};

export function getAuthAvailability(): AuthAvailability {
  const config = privyServerConfig();
  return { privyAppId: config?.appId ?? null, devSignIn: isDevAuthEnabled() };
}
