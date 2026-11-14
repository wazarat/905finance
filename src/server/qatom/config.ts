import "server-only";

/**
 * Where Qatom lives, and what this deployment has been told about it.
 *
 * The addresses are Qatom's published ones. Everything else comes from the
 * environment and is optional: with nothing set, no message is sent through
 * Qatom and the seller endpoint answers nobody.
 */

/** Qatom's master MCP endpoint: discovery and checkout for every public catalog item. */
export const QATOM_MCP_URL = "https://mcp.m.todaq.net/mcp";
/** The authorization server the MCP endpoint names in its own metadata. */
export const QATOM_AUTH_BASE = "https://pay.m.todaq.net";
export const QATOM_AUTHORIZE_URL = `${QATOM_AUTH_BASE}/v4/oidc/auth`;
export const QATOM_TOKEN_URL = `${QATOM_AUTH_BASE}/v4/oidc/token`;
export const QATOM_REGISTER_URL = `${QATOM_AUTH_BASE}/v4/oidc/reg`;
export const QATOM_USERINFO_URL = `${QATOM_AUTH_BASE}/v4/oidc/me`;
export const QATOM_REVOKE_URL = `${QATOM_AUTH_BASE}/v4/oidc/token/revocation`;
export const QATOM_ACCOUNT_TOKEN_URL = `${QATOM_AUTH_BASE}/v4/account/oauth/token`;
export const QATOM_PURCHASE_URL = `${QATOM_AUTH_BASE}/v4/catalog/purchases`;

/** Holds a sign-in that has been started at Qatom and not yet finished. */
export const QATOM_PENDING_COOKIE = "nof_qatom_connect";

/** `offline_access` is what lets a server-side agent keep working after the owner's one sign-in. */
export const QATOM_SCOPES = "openid profile email twin offline_access";

const MIN_SECRET_LENGTH = 32;

/**
 * The secret Qatom presents to the seller endpoint on every delivery, set as
 * a Sensitive `Authorization` header on each catalog item. Null when it is
 * missing or too short, in which case the endpoint does not exist.
 */
export function qatomFulfilmentToken(): string | null {
  const token = process.env.QATOM_FULFILMENT_TOKEN;
  return token && token.length >= MIN_SECRET_LENGTH ? token : null;
}

/**
 * Which Qatom catalog item carries messages to which sample seller, from
 * `QATOM_SELLER_ITEMS`, written as `seller-slug:item-id` pairs separated by
 * commas (for example `relay-qa:412,ledgerproof:413`).
 */
export function qatomSellerItems(): Map<string, number> {
  const items = new Map<string, number>();
  for (const entry of (process.env.QATOM_SELLER_ITEMS ?? "").split(",")) {
    const match = /^\s*([a-z0-9-]{1,80})\s*:\s*(\d{1,12})\s*$/.exec(entry);
    if (match) items.set(match[1], Number(match[2]));
  }
  return items;
}

export function qatomItemFor(sellerSlug: string): number | null {
  return qatomSellerItems().get(sellerSlug) ?? null;
}

/**
 * The seller account's own API credentials (Qatom dashboard, Settings,
 * Secrets). Optional. With them, the seller endpoint confirms every delivery
 * with Qatom itself before acting on it.
 */
export function qatomAccountCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.QATOM_ACCOUNT_CLIENT_ID;
  const clientSecret = process.env.QATOM_ACCOUNT_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

type Fetch = typeof fetch;
let qatomFetch: Fetch | undefined;

/** Every call to Qatom goes through here, with a time limit, so nothing can hang on it. */
export function fetchQatom(url: string, init: RequestInit = {}): Promise<Response> {
  return (qatomFetch ?? fetch)(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30_000) });
}

/** Test hook: stand in for Qatom, or restore the real network with undefined. */
export function setQatomFetch(next: Fetch | undefined): void {
  qatomFetch = next;
}
