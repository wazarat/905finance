import "server-only";
import { PrivyClient } from "@privy-io/node";
import type { PrivyServerConfig } from "../env";

/** What the application learns about a person from a verified login. */
export type VerifiedIdentity = {
  /** Stable subject issued by the identity provider. */
  subject: string;
  email: string | null;
  displayName: string | null;
};

/** Verifies an identity-provider access token. Throws when the token is not valid. */
export interface TokenVerifier {
  verify(accessToken: string): Promise<VerifiedIdentity>;
}

type PrivyLinkedAccount = { type: string } & Record<string, unknown>;

function pickProfile(accounts: PrivyLinkedAccount[]): Pick<VerifiedIdentity, "email" | "displayName"> {
  let email: string | null = null;
  let displayName: string | null = null;
  for (const account of accounts) {
    if (account.type === "email" && typeof account.address === "string") {
      email ??= account.address;
    }
    if (account.type === "google_oauth") {
      if (typeof account.email === "string") email ??= account.email;
      if (typeof account.name === "string") displayName ??= account.name;
    }
  }
  return { email, displayName };
}

/**
 * Verifies Privy access tokens against the app's verification keys, then reads
 * the user's linked accounts from Privy to obtain a contact email.
 */
export class PrivyTokenVerifier implements TokenVerifier {
  private readonly client: PrivyClient;

  constructor(config: PrivyServerConfig) {
    this.client = new PrivyClient({ appId: config.appId, appSecret: config.appSecret });
  }

  async verify(accessToken: string): Promise<VerifiedIdentity> {
    const claims = await this.client.utils().auth().verifyAccessToken(accessToken);
    let profile: Pick<VerifiedIdentity, "email" | "displayName"> = {
      email: null,
      displayName: null,
    };
    try {
      const user = await this.client.users()._get(claims.user_id);
      profile = pickProfile(user.linked_accounts as unknown as PrivyLinkedAccount[]);
    } catch {
      // The token is verified; a failed profile lookup only means no email is prefilled.
    }
    return { subject: claims.user_id, ...profile };
  }
}
