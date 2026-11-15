import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { BillingUnit, EndpointProtocol, ListingStatus } from "@/db/schema";
import { isWeb3Capability } from "@/lib/capabilities";
import { findPublicIdentity, type PublicIdentity } from "./identity";
import { qatomItemFor } from "./qatom/config";
import { currentSettlement } from "./wallets/registry";

const { sellerProfiles, serviceOfferings, serviceEndpoints } = schema;

/**
 * Public marketplace reads. These are passive metadata lookups: they require no
 * sign-in, start no agent session and never touch private seller data.
 *
 * Everything returned here is built from an explicit list of public columns.
 * Endpoint URLs, owning-organization ids and internal ids are not selected.
 */

export type PublicOffering = {
  id: string;
  name: string;
  description: string;
  category: string;
  capability: string;
  billingUnit: BillingUnit;
  priceMinor: number;
  currency: string;
  requiresWeb3: boolean;
  /** Days the seller keeps working, for work over a period. Null for work done once. */
  periodDays: number | null;
};

export type PublicSeller = {
  slug: string;
  displayName: string;
  tagline: string;
  description: string;
  capabilities: string[];
  isSample: boolean;
  status: ListingStatus;
  supportsWeb3: boolean;
  /** Lowest active offering price, for "from $X" display. Null when there are no offerings. */
  startingPriceMinor: number | null;
  startingPriceCurrency: string | null;
  offeringCount: number;
  /** The periods this seller works over, in days, shortest first. Empty when all its work is done at once. */
  periods: number[];
};

export type PublicSellerDetail = PublicSeller & {
  offerings: PublicOffering[];
  /** How the seller's agent is reached. The address itself is never public. */
  endpointProtocol: EndpointProtocol | null;
  /** The seller's Qatom catalog item, when its agent can be reached over Qatom. Public on Qatom already. */
  qatomCatalogItemId: number | null;
  /** The seller's ERC-8004 identity on GOAT, as last read from the chain. Null when none is linked. */
  identity: PublicIdentity | null;
  /** True when a new engagement with this seller would pay for real on GOAT Testnet3 rather than be simulated. */
  settlesOnGoat: boolean;
};

const publicSellerColumns = {
  id: sellerProfiles.id,
  slug: sellerProfiles.slug,
  displayName: sellerProfiles.displayName,
  tagline: sellerProfiles.tagline,
  description: sellerProfiles.description,
  capabilities: sellerProfiles.capabilities,
  isSample: sellerProfiles.isSample,
  status: sellerProfiles.status,
};

const publicOfferingColumns = {
  id: serviceOfferings.id,
  sellerProfileId: serviceOfferings.sellerProfileId,
  name: serviceOfferings.name,
  description: serviceOfferings.description,
  category: serviceOfferings.category,
  capability: serviceOfferings.capability,
  billingUnit: serviceOfferings.billingUnit,
  priceMinor: serviceOfferings.priceMinor,
  currency: serviceOfferings.currency,
  requiresWeb3: serviceOfferings.requiresWeb3,
  periodDays: serviceOfferings.periodDays,
};

type SellerRow = {
  id: string;
  slug: string;
  displayName: string;
  tagline: string;
  description: string;
  capabilities: string[];
  isSample: boolean;
  status: ListingStatus;
};
type OfferingRow = PublicOffering & { sellerProfileId: string };

function toPublicOffering(row: OfferingRow): PublicOffering {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    capability: row.capability,
    billingUnit: row.billingUnit,
    priceMinor: row.priceMinor,
    currency: row.currency,
    requiresWeb3: row.requiresWeb3,
    periodDays: row.periodDays,
  };
}

function toPublicSeller(row: SellerRow, offerings: OfferingRow[]): PublicSeller {
  const cheapest = offerings.reduce<OfferingRow | null>(
    (min, o) => (min === null || o.priceMinor < min.priceMinor ? o : min),
    null,
  );
  return {
    slug: row.slug,
    displayName: row.displayName,
    tagline: row.tagline,
    description: row.description,
    capabilities: row.capabilities,
    isSample: row.isSample,
    status: row.status,
    supportsWeb3: row.capabilities.some(isWeb3Capability),
    startingPriceMinor: cheapest?.priceMinor ?? null,
    startingPriceCurrency: cheapest?.currency ?? null,
    offeringCount: offerings.length,
    periods: [...new Set(offerings.flatMap((o) => (o.periodDays ? [o.periodDays] : [])))].sort((a, b) => a - b),
  };
}

/** Build the public view of one listing. Shared with the owner's own preview. */
export async function loadPublicSellerDetail(sellerProfileId: string): Promise<PublicSellerDetail | null> {
  const db = getDb();
  const [row] = await db
    .select(publicSellerColumns)
    .from(sellerProfiles)
    .where(eq(sellerProfiles.id, sellerProfileId));
  if (!row) return null;
  const offerings = await db
    .select(publicOfferingColumns)
    .from(serviceOfferings)
    .where(
      and(eq(serviceOfferings.sellerProfileId, row.id), eq(serviceOfferings.isActive, true)),
    )
    .orderBy(asc(serviceOfferings.priceMinor), asc(serviceOfferings.name));
  const [endpoint] = await db
    .select({ protocol: serviceEndpoints.protocol })
    .from(serviceEndpoints)
    .where(eq(serviceEndpoints.sellerProfileId, row.id));
  const identity = await findPublicIdentity(row.id);
  return {
    ...toPublicSeller(row, offerings),
    offerings: offerings.map(toPublicOffering),
    endpointProtocol: endpoint?.protocol ?? null,
    qatomCatalogItemId: qatomItemFor(row.slug),
    identity,
    settlesOnGoat:
      currentSettlement() === "goat_testnet3" && identity !== null && identity.confirmed && identity.agentWalletSet,
  };
}

export type SellerFilters = {
  query?: string;
  capability?: string;
  /** "yes" = sellers with Web3 capabilities, "no" = sellers without, undefined = all. */
  web3?: "yes" | "no";
};

/** Active listings only. Drafts, pending and suspended listings never appear. */
export async function listPublicSellers(filters: SellerFilters = {}): Promise<PublicSeller[]> {
  const db = getDb();
  const rows = await db
    .select(publicSellerColumns)
    .from(sellerProfiles)
    .where(eq(sellerProfiles.status, "active"))
    .orderBy(desc(sellerProfiles.activatedAt), asc(sellerProfiles.displayName));
  if (rows.length === 0) return [];

  const offerings = await db
    .select(publicOfferingColumns)
    .from(serviceOfferings)
    .where(
      and(
        inArray(
          serviceOfferings.sellerProfileId,
          rows.map((r) => r.id),
        ),
        eq(serviceOfferings.isActive, true),
      ),
    );
  const bySeller = new Map<string, OfferingRow[]>();
  for (const offering of offerings) {
    const list = bySeller.get(offering.sellerProfileId) ?? [];
    list.push(offering);
    bySeller.set(offering.sellerProfileId, list);
  }

  const query = filters.query?.trim().toLowerCase().slice(0, 100);
  return rows
    .map((row) => ({ seller: toPublicSeller(row, bySeller.get(row.id) ?? []), row }))
    .filter(({ seller, row }) => {
      if (filters.capability && !seller.capabilities.includes(filters.capability)) return false;
      if (filters.web3 === "yes" && !seller.supportsWeb3) return false;
      if (filters.web3 === "no" && seller.supportsWeb3) return false;
      if (query) {
        const haystack = [
          seller.displayName,
          seller.tagline,
          seller.description,
          ...seller.capabilities,
          ...(bySeller.get(row.id) ?? []).map((o) => o.name),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    })
    .map(({ seller }) => seller);
}

/** A single active listing by slug, or null. Non-active listings are indistinguishable from missing ones. */
export async function getPublicSellerBySlug(slug: string): Promise<PublicSellerDetail | null> {
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return null;
  const [row] = await getDb()
    .select({ id: sellerProfiles.id })
    .from(sellerProfiles)
    .where(and(eq(sellerProfiles.slug, slug), eq(sellerProfiles.status, "active")));
  if (!row) return null;
  return loadPublicSellerDetail(row.id);
}
