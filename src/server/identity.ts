import "server-only";
import { and, eq, ne } from "drizzle-orm";
import { getDb, schema, type DbOrTx } from "@/db/client";
import type { BuyerIdentity, BuyerProfile, SellerIdentity, SellerProfile } from "@/db/schema";
import { recordAudit } from "./audit";
import { assertAuthenticated, isUuid, requirePermission, roleHasPermission, type Actor } from "./authz";
import { conflict, invalid, notFound } from "./errors";
import {
  parseAgentId,
  readAgentIdentity,
  readAgentReputation,
  type AgentIdentity,
  type AgentReputation,
} from "./goat/erc8004";

const { buyerIdentities, buyerProfiles, organizations, sellerProfiles, sellerIdentities } = schema;

/**
 * Linking a seller's listing to its ERC-8004 identity on GOAT.
 *
 * The seller supplies an agent id and nothing else. Who owns the agent,
 * where it is paid and what its registration says are read from the chain.
 * A link counts as confirmed only when the agent's own registration
 * document names this listing: the listing claims the agent, and the agent
 * claims the listing. Until then it is shown as an unconfirmed claim, and
 * its wallet is never used to pay anyone.
 */

/** Hosts this application is served from, where a registration may point back at a listing. */
function applicationHosts(): string[] {
  const hosts = new Set(["905finance.com", "www.905finance.com", "905finance.vercel.app"]);
  try {
    if (process.env.NEXT_PUBLIC_APP_URL) hosts.add(new URL(process.env.NEXT_PUBLIC_APP_URL).host);
  } catch {
    // An unusable setting adds nothing.
  }
  return [...hosts];
}

/** The host to show a seller when telling them what their registration should point at. */
function canonicalHost(): string {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "");
    if (url.protocol === "https:") return url.host;
  } catch {
    // Fall through to the default.
  }
  return "905finance.vercel.app";
}

/** Where this application serves the registration document for a listing, and for a buying agent. */
export const sellerRegistrationPath = (slug: string) => `/agents/${slug}/registration.json`;
export const buyerRegistrationPath = (buyerProfileId: string) => `/buyers/${buyerProfileId}/registration.json`;

export function hostedUrl(path: string): string {
  return `https://${canonicalHost()}${path}`;
}

/**
 * True when the agent's own registration, on the chain, is the document this
 * application serves at `path`. Only the agent's owner can set that, so it is
 * the owner saying which listing or buyer the agent is.
 */
export function registrationIsHostedAt(agentUri: string, path: string): boolean {
  try {
    const url = new URL(agentUri);
    return url.protocol === "https:" && applicationHosts().includes(url.host) && url.pathname === path && !url.search;
  } catch {
    return false;
  }
}

/** True when one of the registration's services is this listing's own page. */
export function registrationNamesListing(identity: AgentIdentity, slug: string): boolean {
  if (!identity.registration?.namesThisAgent) return false;
  const hosts = applicationHosts();
  return identity.registration.services.some((service) => {
    try {
      const url = new URL(service.endpoint);
      return (
        url.protocol === "https:" &&
        hosts.includes(url.host) &&
        url.pathname.replace(/\/+$/, "") === `/agents/${slug}`
      );
    } catch {
      return false;
    }
  });
}

export type IdentityReading = {
  identity: AgentIdentity;
  reputation: AgentReputation;
  confirmed: boolean;
  /** What the registration must contain for the link to be confirmed. */
  listingUrl: string;
};

async function findProfile(organizationId: string): Promise<SellerProfile> {
  const [profile] = await getDb()
    .select()
    .from(sellerProfiles)
    .where(eq(sellerProfiles.organizationId, organizationId));
  if (!profile) throw notFound("Seller listing");
  return profile;
}

async function read(profile: SellerProfile, rawAgentId: unknown): Promise<IdentityReading> {
  const agentId = parseAgentId(rawAgentId);
  if (agentId === null) {
    throw invalid("Check the highlighted fields.", { agentId: ["Enter the agent's id, a whole number."] });
  }
  let identity: AgentIdentity | null;
  let reputation: AgentReputation;
  try {
    identity = await readAgentIdentity(agentId);
    reputation = identity ? await readAgentReputation(agentId) : { clients: 0, count: 0, value: null };
  } catch {
    throw conflict("GOAT Network could not be read just now. Try again shortly.");
  }
  if (!identity) {
    throw invalid("Check the highlighted fields.", {
      agentId: ["No agent with that id is registered on GOAT Testnet3."],
    });
  }
  return {
    identity,
    reputation,
    confirmed:
      registrationNamesListing(identity, profile.slug) ||
      registrationIsHostedAt(identity.agentUri, sellerRegistrationPath(profile.slug)),
    listingUrl: `https://${canonicalHost()}/agents/${profile.slug}`,
  };
}

function toRow(reading: IdentityReading) {
  const { identity, reputation } = reading;
  return {
    agentRegistry: identity.agentRegistry,
    agentId: identity.agentId,
    ownerAddress: identity.owner,
    agentWallet: identity.agentWallet,
    agentWalletSet: identity.agentWalletSet,
    agentUri: identity.agentUri,
    registration: identity.registration as Record<string, unknown> | null,
    registrationProblem: identity.registrationProblem,
    confirmed: reading.confirmed,
    reputationClients: reputation.clients,
    reputationCount: reputation.count,
    reputationValue: reputation.value,
    refreshedAt: new Date(),
  };
}

async function store(
  profile: SellerProfile,
  reading: IdentityReading,
  linkedBy: string | null,
): Promise<SellerIdentity> {
  const db = getDb();
  const [taken] = await db
    .select({ id: sellerIdentities.sellerProfileId })
    .from(sellerIdentities)
    .where(
      and(
        eq(sellerIdentities.agentRegistry, reading.identity.agentRegistry),
        eq(sellerIdentities.agentId, reading.identity.agentId),
        ne(sellerIdentities.sellerProfileId, profile.id),
      ),
    );
  if (taken) throw conflict("That agent is already linked to another listing.");
  const [buying] = await db
    .select({ id: buyerIdentities.buyerProfileId })
    .from(buyerIdentities)
    .where(
      and(
        eq(buyerIdentities.agentRegistry, reading.identity.agentRegistry),
        eq(buyerIdentities.agentId, reading.identity.agentId),
      ),
    );
  if (buying) throw conflict("That agent is already linked as a buying agent.");
  const row = toRow(reading);
  const [saved] = await db
    .insert(sellerIdentities)
    .values({ sellerProfileId: profile.id, ...row, linkedBy })
    .onConflictDoUpdate({ target: sellerIdentities.sellerProfileId, set: { ...row, linkedBy, linkedAt: new Date() } })
    .returning();
  return saved;
}

/** Link the organization's listing to an agent id. What is stored is what the chain says. */
export async function linkSellerIdentity(
  actor: Actor | null,
  organizationId: string,
  input: { agentId: unknown },
): Promise<SellerIdentity> {
  await requirePermission(actor, organizationId, "seller_listing.manage");
  assertAuthenticated(actor);
  const profile = await findProfile(organizationId);
  const saved = await store(profile, await read(profile, input.agentId), actor.userId);
  await recordAudit({
    actorUserId: actor.userId,
    organizationId,
    action: "seller_identity.linked",
    entityType: "seller_profile",
    entityId: profile.id,
    metadata: { agentId: saved.agentId, confirmed: saved.confirmed, agentWallet: saved.agentWallet },
  });
  return saved;
}

/** Read the chain again for a listing's linked agent, and store what it says now. */
export async function refreshSellerIdentity(
  sellerProfileId: string,
  db: DbOrTx = getDb(),
): Promise<SellerIdentity | null> {
  const [existing] = await db
    .select()
    .from(sellerIdentities)
    .where(eq(sellerIdentities.sellerProfileId, sellerProfileId));
  if (!existing) return null;
  const [profile] = await db.select().from(sellerProfiles).where(eq(sellerProfiles.id, sellerProfileId));
  const reading = await read(profile, existing.agentId);
  const [saved] = await db
    .update(sellerIdentities)
    .set(toRow(reading))
    .where(eq(sellerIdentities.sellerProfileId, sellerProfileId))
    .returning();
  return saved;
}

export async function refreshOwnSellerIdentity(
  actor: Actor | null,
  organizationId: string,
): Promise<SellerIdentity | null> {
  await requirePermission(actor, organizationId, "seller_listing.manage");
  return refreshSellerIdentity((await findProfile(organizationId)).id);
}

export async function unlinkSellerIdentity(actor: Actor | null, organizationId: string): Promise<void> {
  await requirePermission(actor, organizationId, "seller_listing.manage");
  assertAuthenticated(actor);
  const profile = await findProfile(organizationId);
  await getDb().delete(sellerIdentities).where(eq(sellerIdentities.sellerProfileId, profile.id));
  await recordAudit({
    actorUserId: actor.userId,
    organizationId,
    action: "seller_identity.unlinked",
    entityType: "seller_profile",
    entityId: profile.id,
  });
}

/** The organization's own view of its linked identity, with what would confirm it. */
export async function getOwnSellerIdentity(
  actor: Actor | null,
  organizationId: string,
): Promise<{ identity: SellerIdentity | null; listingUrl: string; registrationUrl: string } | null> {
  await requirePermission(actor, organizationId, "seller_listing.view");
  const [profile] = await getDb()
    .select()
    .from(sellerProfiles)
    .where(eq(sellerProfiles.organizationId, organizationId));
  if (!profile) return null;
  const [identity] = await getDb()
    .select()
    .from(sellerIdentities)
    .where(eq(sellerIdentities.sellerProfileId, profile.id));
  return {
    identity: identity ?? null,
    listingUrl: `https://${canonicalHost()}/agents/${profile.slug}`,
    registrationUrl: hostedUrl(sellerRegistrationPath(profile.slug)),
  };
}

/**
 * The registration document this application serves for an active listing,
 * in the form ERC-8004 describes. It names the listing's own page, and names
 * an agent only once the listing has linked one.
 */
export async function sellerRegistrationDocument(slug: string): Promise<Record<string, unknown> | null> {
  const [profile] = await getDb().select().from(sellerProfiles).where(eq(sellerProfiles.slug, slug));
  if (!profile || profile.status !== "active") return null;
  const [identity] = await getDb()
    .select()
    .from(sellerIdentities)
    .where(eq(sellerIdentities.sellerProfileId, profile.id));
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: profile.displayName,
    description: profile.tagline,
    services: [{ name: "web", endpoint: `https://${canonicalHost()}/agents/${profile.slug}` }],
    x402Support: false,
    active: true,
    registrations: identity ? [{ agentId: identity.agentId, agentRegistry: identity.agentRegistry }] : [],
    supportedTrust: ["reputation"],
  };
}

// ---------------------------------------------------------------------------
// The buying agent's identity
// ---------------------------------------------------------------------------

async function findBuyerProfile(organizationId: string): Promise<BuyerProfile> {
  const [profile] = await getDb()
    .select()
    .from(buyerProfiles)
    .where(eq(buyerProfiles.organizationId, organizationId));
  if (!profile) throw notFound("Buyer profile");
  return profile;
}

async function readForBuyer(profile: BuyerProfile, rawAgentId: unknown) {
  const agentId = parseAgentId(rawAgentId);
  if (agentId === null) {
    throw invalid("Check the highlighted fields.", { agentId: ["Enter the agent's id, a whole number."] });
  }
  let identity: AgentIdentity | null;
  try {
    identity = await readAgentIdentity(agentId);
  } catch {
    throw conflict("GOAT Network could not be read just now. Try again shortly.");
  }
  if (!identity) {
    throw invalid("Check the highlighted fields.", {
      agentId: ["No agent with that id is registered on GOAT Testnet3."],
    });
  }
  return {
    agentRegistry: identity.agentRegistry,
    agentId: identity.agentId,
    ownerAddress: identity.owner,
    agentUri: identity.agentUri,
    registration: identity.registration as Record<string, unknown> | null,
    registrationProblem: identity.registrationProblem,
    // A buying agent is confirmed one way only: its registration on the chain is this buyer's own document.
    confirmed: registrationIsHostedAt(identity.agentUri, buyerRegistrationPath(profile.id)),
    refreshedAt: new Date(),
  };
}

/** Link the organization's buying agent to an ERC-8004 agent id. What is stored is what the chain says. */
export async function linkBuyerIdentity(
  actor: Actor | null,
  organizationId: string,
  input: { agentId: unknown },
): Promise<BuyerIdentity> {
  await requirePermission(actor, organizationId, "org.update");
  assertAuthenticated(actor);
  const profile = await findBuyerProfile(organizationId);
  const row = await readForBuyer(profile, input.agentId);
  const db = getDb();
  const [takenByBuyer] = await db
    .select({ id: buyerIdentities.buyerProfileId })
    .from(buyerIdentities)
    .where(
      and(
        eq(buyerIdentities.agentRegistry, row.agentRegistry),
        eq(buyerIdentities.agentId, row.agentId),
        ne(buyerIdentities.buyerProfileId, profile.id),
      ),
    );
  const [takenBySeller] = await db
    .select({ id: sellerIdentities.sellerProfileId })
    .from(sellerIdentities)
    .where(and(eq(sellerIdentities.agentRegistry, row.agentRegistry), eq(sellerIdentities.agentId, row.agentId)));
  if (takenByBuyer || takenBySeller) throw conflict("That agent is already linked to someone else.");
  const [saved] = await db
    .insert(buyerIdentities)
    .values({ buyerProfileId: profile.id, ...row, linkedBy: actor.userId })
    .onConflictDoUpdate({
      target: buyerIdentities.buyerProfileId,
      set: { ...row, linkedBy: actor.userId, linkedAt: new Date() },
    })
    .returning();
  await recordAudit({
    actorUserId: actor.userId,
    organizationId,
    action: "buyer_identity.linked",
    entityType: "buyer_profile",
    entityId: profile.id,
    metadata: { agentId: saved.agentId, confirmed: saved.confirmed },
  });
  return saved;
}

/** Read the chain again for the organization's buying agent. */
export async function refreshBuyerIdentity(actor: Actor | null, organizationId: string): Promise<BuyerIdentity | null> {
  await requirePermission(actor, organizationId, "org.update");
  const profile = await findBuyerProfile(organizationId);
  const [existing] = await getDb()
    .select()
    .from(buyerIdentities)
    .where(eq(buyerIdentities.buyerProfileId, profile.id));
  if (!existing) return null;
  const [saved] = await getDb()
    .update(buyerIdentities)
    .set(await readForBuyer(profile, existing.agentId))
    .where(eq(buyerIdentities.buyerProfileId, profile.id))
    .returning();
  return saved;
}

export async function unlinkBuyerIdentity(actor: Actor | null, organizationId: string): Promise<void> {
  await requirePermission(actor, organizationId, "org.update");
  assertAuthenticated(actor);
  const profile = await findBuyerProfile(organizationId);
  await getDb().delete(buyerIdentities).where(eq(buyerIdentities.buyerProfileId, profile.id));
  await recordAudit({
    actorUserId: actor.userId,
    organizationId,
    action: "buyer_identity.unlinked",
    entityType: "buyer_profile",
    entityId: profile.id,
  });
}

/** The organization's own view of its buying agent's identity, and the document to register it with. */
export async function getOwnBuyerIdentity(
  actor: Actor | null,
  organizationId: string,
): Promise<{ identity: BuyerIdentity | null; registrationUrl: string; canManage: boolean } | null> {
  const membership = await requirePermission(actor, organizationId, "engagement.view");
  const [profile] = await getDb()
    .select()
    .from(buyerProfiles)
    .where(eq(buyerProfiles.organizationId, organizationId));
  if (!profile) return null;
  const [identity] = await getDb()
    .select()
    .from(buyerIdentities)
    .where(eq(buyerIdentities.buyerProfileId, profile.id));
  return {
    identity: identity ?? null,
    registrationUrl: hostedUrl(buyerRegistrationPath(profile.id)),
    canManage: roleHasPermission(membership.role, "org.update"),
  };
}

/**
 * The registration document for a buying agent. Its address contains the
 * buyer's own unguessable id, so it is found only by someone the buyer gave
 * it to, or once the buyer has put it on the chain themselves.
 */
export async function buyerRegistrationDocument(buyerProfileId: string): Promise<Record<string, unknown> | null> {
  if (!isUuid(buyerProfileId)) return null;
  const [row] = await getDb()
    .select({ profile: buyerProfiles, organization: organizations })
    .from(buyerProfiles)
    .innerJoin(organizations, eq(organizations.id, buyerProfiles.organizationId))
    .where(eq(buyerProfiles.id, buyerProfileId));
  if (!row) return null;
  const [identity] = await getDb()
    .select()
    .from(buyerIdentities)
    .where(eq(buyerIdentities.buyerProfileId, buyerProfileId));
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: `${row.organization.name} buying agent`,
    description: "A purchasing agent on 905 Finance. It buys services for its organization inside a mandate a person authorized.",
    services: [{ name: "web", endpoint: `https://${canonicalHost()}` }],
    x402Support: false,
    active: true,
    registrations: identity ? [{ agentId: identity.agentId, agentRegistry: identity.agentRegistry }] : [],
    supportedTrust: ["reputation"],
  };
}

/**
 * Platform operation: link a listing to an agent id without a signed-in
 * owner, for the sample sellers. The same reading and the same confirmation
 * rule apply; an operator cannot confirm a link the registration does not.
 */
export async function linkSellerIdentityAsOperator(slug: string, agentId: unknown): Promise<SellerIdentity> {
  const [profile] = await getDb().select().from(sellerProfiles).where(eq(sellerProfiles.slug, slug));
  if (!profile) throw notFound("Seller listing");
  return store(profile, await read(profile, agentId), null);
}

/** What anyone may see of a listing's identity. All of it is already public on the chain. */
export type PublicIdentity = {
  agentRegistry: string;
  agentId: string;
  ownerAddress: string;
  agentWallet: string;
  agentWalletSet: boolean;
  confirmed: boolean;
  registeredName: string | null;
  services: Array<{ name: string; endpoint: string }>;
  registrationProblem: string | null;
  reputation: { clients: number; count: number; value: string | null };
  refreshedAt: Date;
};

export function toPublicIdentity(row: SellerIdentity): PublicIdentity {
  const registration = row.registration as { name?: unknown; services?: unknown } | null;
  const services = Array.isArray(registration?.services)
    ? registration.services.flatMap((entry) =>
        entry && typeof entry === "object" && typeof entry.name === "string" && typeof entry.endpoint === "string"
          ? [{ name: entry.name as string, endpoint: entry.endpoint as string }]
          : [],
      )
    : [];
  return {
    agentRegistry: row.agentRegistry,
    agentId: row.agentId,
    ownerAddress: row.ownerAddress,
    agentWallet: row.agentWallet,
    agentWalletSet: row.agentWalletSet,
    confirmed: row.confirmed,
    registeredName: typeof registration?.name === "string" ? registration.name : null,
    services,
    registrationProblem: row.registrationProblem,
    reputation: { clients: row.reputationClients, count: row.reputationCount, value: row.reputationValue },
    refreshedAt: row.refreshedAt,
  };
}

export async function findPublicIdentity(sellerProfileId: string): Promise<PublicIdentity | null> {
  const [row] = await getDb()
    .select()
    .from(sellerIdentities)
    .where(eq(sellerIdentities.sellerProfileId, sellerProfileId));
  return row ? toPublicIdentity(row) : null;
}

/**
 * The wallet a seller may be paid at on GOAT: the one its confirmed identity
 * has set in the registry, and nothing else. Null when the identity is not
 * confirmed, or when the registry holds no wallet for the agent (which is
 * also what it reports after the identity changes hands): an owner address
 * standing in is good enough to show, not to pay.
 */
export async function verifiedReceivingWallet(
  sellerProfileId: string,
  db: DbOrTx = getDb(),
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(sellerIdentities)
    .where(eq(sellerIdentities.sellerProfileId, sellerProfileId));
  return row?.confirmed && row.agentWalletSet ? row.agentWallet : null;
}
