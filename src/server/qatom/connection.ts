import "server-only";
import { createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type DbOrTx } from "@/db/client";
import type { QatomConnection } from "@/db/schema";
import { recordAudit } from "../audit";
import { assertAuthenticated, requirePermission, type Actor } from "../authz";
import { sessionSecret } from "../env";
import { conflict, forbidden, invalid } from "../errors";
import {
  QATOM_AUTHORIZE_URL,
  QATOM_REGISTER_URL,
  QATOM_REVOKE_URL,
  QATOM_SCOPES,
  QATOM_TOKEN_URL,
  QATOM_USERINFO_URL,
  fetchQatom,
} from "./config";
import { randomToken, seal, unseal } from "./crypto";

const { qatomConnections, qatomOauthClients, buyerProfiles } = schema;

/**
 * Linking a buying organization to its Qatom account.
 *
 * The owner signs in at Qatom, in Qatom's own pages. This application never
 * sees a Qatom password or sign-in code: it receives tokens, stores them
 * encrypted, and uses them only to send the organization's agents' messages
 * through Qatom. Linking the account authorizes no payment, and signing in to
 * this application says nothing about Qatom: the two are separate consents.
 */

const PENDING_AUDIENCE = "905finance:qatom-connect";
const PENDING_TTL_SECONDS = 10 * 60;
/** Refresh a little early, so a token does not expire in the middle of a call. */
const EXPIRY_MARGIN_MS = 60_000;

const tokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().positive().optional(),
  scope: z.string().optional(),
});

/** A sign-in that has been started and not finished. Kept in a signed, short-lived cookie. */
export type PendingConnect = {
  state: string;
  verifier: string;
  organizationId: string;
  userId: string;
  redirectUri: string;
  clientId: string;
};

export async function sealPending(pending: PendingConnect): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...pending })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setAudience(PENDING_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + PENDING_TTL_SECONDS)
    .sign(sessionSecret());
}

export async function openPending(token: string | undefined | null): Promise<PendingConnect | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionSecret(), {
      audience: PENDING_AUDIENCE,
      algorithms: ["HS256"],
    });
    const fields = ["state", "verifier", "organizationId", "userId", "redirectUri", "clientId"] as const;
    if (fields.some((field) => typeof payload[field] !== "string")) return null;
    return Object.fromEntries(fields.map((field) => [field, payload[field]])) as PendingConnect;
  } catch {
    return null;
  }
}

/**
 * This application's OAuth client at Qatom for one redirect address,
 * registered the first time it is needed. A public client with no secret.
 */
async function ensureClient(redirectUri: string): Promise<string> {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(qatomOauthClients)
    .where(eq(qatomOauthClients.redirectUri, redirectUri));
  if (existing) return existing.clientId;

  const response = await fetchQatom(QATOM_REGISTER_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "905 Finance",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: QATOM_SCOPES,
    }),
  });
  const body = z.object({ client_id: z.string().min(1) }).safeParse(await response.json().catch(() => null));
  if (!response.ok || !body.success) {
    throw conflict("Qatom did not accept this application as a client. Try again later.");
  }
  await db
    .insert(qatomOauthClients)
    .values({ redirectUri, clientId: body.data.client_id })
    .onConflictDoNothing();
  const [stored] = await db
    .select()
    .from(qatomOauthClients)
    .where(eq(qatomOauthClients.redirectUri, redirectUri));
  return stored.clientId;
}

/** Begin linking: returns the Qatom page to send the owner to, and what to remember until they return. */
export async function startQatomConnect(
  actor: Actor | null,
  organizationId: string,
  redirectUri: string,
): Promise<{ url: string; pending: PendingConnect }> {
  await requirePermission(actor, organizationId, "qatom.manage");
  assertAuthenticated(actor);
  const [buyer] = await getDb()
    .select({ id: buyerProfiles.id })
    .from(buyerProfiles)
    .where(eq(buyerProfiles.organizationId, organizationId));
  if (!buyer) throw forbidden("Enable buying for this organization first.");

  const clientId = await ensureClient(redirectUri);
  const state = randomToken(24);
  const verifier = randomToken(48);
  const url = new URL(QATOM_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: QATOM_SCOPES,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return {
    url: url.toString(),
    pending: { state, verifier, organizationId, userId: actor.userId, redirectUri, clientId },
  };
}

async function requestTokens(parameters: Record<string, string>) {
  const response = await fetchQatom(QATOM_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(parameters).toString(),
  });
  const parsed = tokenResponse.safeParse(await response.json().catch(() => null));
  return response.ok && parsed.success ? parsed.data : null;
}

const expiryOf = (expiresIn: number | undefined) =>
  // With no stated lifetime, assume a short one and let refresh sort it out.
  new Date(Date.now() + (expiresIn ?? 300) * 1000);

/** Finish linking, when the owner comes back from Qatom with a code. */
export async function finishQatomConnect(
  actor: Actor | null,
  pending: PendingConnect | null,
  returned: { code: string | null; state: string | null },
): Promise<void> {
  assertAuthenticated(actor);
  if (!pending || !returned.code || !returned.state || returned.state !== pending.state) {
    throw invalid("That sign-in could not be completed. Start again from Settings.");
  }
  // The person finishing must be the person who started, and still the owner.
  if (pending.userId !== actor.userId) throw forbidden();
  await requirePermission(actor, pending.organizationId, "qatom.manage");

  const tokens = await requestTokens({
    grant_type: "authorization_code",
    code: returned.code,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.verifier,
  });
  if (!tokens) throw conflict("Qatom did not complete the sign-in. Start again from Settings.");

  // Who signed in, so the owner can see which Qatom account is linked.
  const identity = { subject: "", email: null as string | null, primaryTwin: null as string | null, agentTwin: null as string | null };
  try {
    const response = await fetchQatom(QATOM_USERINFO_URL, {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" },
    });
    const info = z
      .object({
        sub: z.string().max(300).optional(),
        email: z.string().max(300).optional(),
        twin_hostname: z.string().max(300).optional(),
        agent_twin_hostname: z.string().max(300).optional(),
      })
      .safeParse(response.ok ? await response.json() : null);
    if (info.success) {
      identity.subject = info.data.sub ?? "";
      identity.email = info.data.email ?? null;
      identity.primaryTwin = info.data.twin_hostname ?? null;
      identity.agentTwin = info.data.agent_twin_hostname ?? null;
    }
  } catch {
    // The link works without these; they are only shown for reference.
  }

  const row = {
    connectedBy: actor.userId,
    clientId: pending.clientId,
    ...identity,
    scope: tokens.scope ?? "",
    accessTokenSealed: seal(tokens.access_token),
    accessTokenExpiresAt: expiryOf(tokens.expires_in),
    refreshTokenSealed: tokens.refresh_token ? seal(tokens.refresh_token) : null,
    status: "connected" as const,
    lastError: null,
    updatedAt: new Date(),
  };
  await getDb().transaction(async (tx) => {
    await tx
      .insert(qatomConnections)
      .values({ organizationId: pending.organizationId, ...row })
      .onConflictDoUpdate({ target: qatomConnections.organizationId, set: row });
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId: pending.organizationId,
        action: "qatom.connected",
        entityType: "qatom_connection",
        entityId: pending.organizationId,
        metadata: { agentTwin: identity.agentTwin },
      },
      tx,
    );
  });
}

/** Unlink the account: the stored tokens are revoked at Qatom where possible, and deleted here. */
export async function disconnectQatom(actor: Actor | null, organizationId: string): Promise<void> {
  await requirePermission(actor, organizationId, "qatom.manage");
  assertAuthenticated(actor);
  const db = getDb();
  const [connection] = await db
    .select()
    .from(qatomConnections)
    .where(eq(qatomConnections.organizationId, organizationId));
  if (!connection) return;

  const token = unseal(connection.refreshTokenSealed) ?? unseal(connection.accessTokenSealed);
  if (token) {
    try {
      await fetchQatom(QATOM_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, client_id: connection.clientId }).toString(),
      });
    } catch {
      // Deleting our copy is what matters; revocation at Qatom is a courtesy on top.
    }
  }
  await db.transaction(async (tx) => {
    await tx.delete(qatomConnections).where(eq(qatomConnections.organizationId, organizationId));
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId,
        action: "qatom.disconnected",
        entityType: "qatom_connection",
        entityId: organizationId,
      },
      tx,
    );
  });
}

export type QatomStatus = {
  connected: boolean;
  needsReconnect: boolean;
  email: string | null;
  primaryTwin: string | null;
  agentTwin: string | null;
  connectedAt: Date | null;
  lastError: string | null;
  canManage: boolean;
};

/** What a member may see of the link. Never includes a token. */
export async function getQatomStatus(actor: Actor | null, organizationId: string): Promise<QatomStatus> {
  const membership = await requirePermission(actor, organizationId, "qatom.view");
  const [connection] = await getDb()
    .select()
    .from(qatomConnections)
    .where(eq(qatomConnections.organizationId, organizationId));
  return {
    connected: connection?.status === "connected",
    needsReconnect: connection?.status === "needs_reconnect",
    email: connection?.email ?? null,
    primaryTwin: connection?.primaryTwin ?? null,
    agentTwin: connection?.agentTwin ?? null,
    connectedAt: connection?.createdAt ?? null,
    lastError: connection?.lastError ?? null,
    canManage: membership.role === "owner",
  };
}

/** Whether an organization's agents can send through Qatom right now. */
export async function hasUsableQatomConnection(
  organizationId: string,
  db: DbOrTx = getDb(),
): Promise<boolean> {
  const [connection] = await db
    .select({ status: qatomConnections.status })
    .from(qatomConnections)
    .where(eq(qatomConnections.organizationId, organizationId));
  return connection?.status === "connected";
}

async function markNeedsReconnect(db: DbOrTx, connection: QatomConnection, reason: string): Promise<null> {
  await db
    .update(qatomConnections)
    .set({ status: "needs_reconnect", lastError: reason, updatedAt: new Date() })
    .where(eq(qatomConnections.organizationId, connection.organizationId));
  return null;
}

/**
 * A working access token for an organization's agents, refreshed when it has
 * run out. Null when the link is missing or can no longer be renewed, in
 * which case the owner has to sign in at Qatom again.
 *
 * The row is locked while a refresh is in flight, because a refresh token
 * may work only once: two agents must not both spend it.
 */
export async function qatomAccessToken(
  organizationId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<string | null> {
  return getDb().transaction(async (tx) => {
    const [connection] = await tx
      .select()
      .from(qatomConnections)
      .where(eq(qatomConnections.organizationId, organizationId))
      .for("update");
    if (!connection || connection.status !== "connected") return null;

    const current = unseal(connection.accessTokenSealed);
    const fresh = connection.accessTokenExpiresAt.getTime() - Date.now() > EXPIRY_MARGIN_MS;
    if (current && fresh && !options.forceRefresh) return current;

    const refreshToken = unseal(connection.refreshTokenSealed);
    if (!refreshToken) {
      return markNeedsReconnect(tx, connection, "The Qatom sign-in has expired.");
    }
    let tokens: Awaited<ReturnType<typeof requestTokens>>;
    try {
      tokens = await requestTokens({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: connection.clientId,
      });
    } catch {
      // Qatom could not be reached. The link itself may be fine, so leave it be.
      return null;
    }
    if (!tokens) return markNeedsReconnect(tx, connection, "Qatom would not renew the sign-in.");

    await tx
      .update(qatomConnections)
      .set({
        accessTokenSealed: seal(tokens.access_token),
        accessTokenExpiresAt: expiryOf(tokens.expires_in),
        // A new refresh token replaces the old one; none means the old one still stands.
        refreshTokenSealed: tokens.refresh_token ? seal(tokens.refresh_token) : connection.refreshTokenSealed,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(qatomConnections.organizationId, organizationId));
    return tokens.access_token;
  });
}
