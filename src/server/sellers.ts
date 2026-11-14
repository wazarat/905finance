import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { getDb, schema, type DbOrTx } from "@/db/client";
import type { SellerProfile, ServiceEndpoint, ServiceOffering } from "@/db/schema";
import { isWeb3Capability } from "@/lib/capabilities";
import { recordAudit } from "./audit";
import { assertAuthenticated, isUuid, requirePermission, type Actor } from "./authz";
import { conflict, invalid, notFound } from "./errors";
import { loadPublicSellerDetail, type PublicSellerDetail } from "./marketplace";
import { endpointInput, offeringInput, parseInput, sellerListingInput } from "./validation";

const { sellerProfiles, serviceOfferings, serviceEndpoints, mandatePermittedOfferings } = schema;

/** The owning organization's full view of its listing, including private fields. */
export type SellerListing = {
  profile: SellerProfile;
  offerings: ServiceOffering[];
  endpoint: ServiceEndpoint | null;
};

async function findProfileForOrg(db: DbOrTx, organizationId: string): Promise<SellerProfile | null> {
  const [profile] = await db
    .select()
    .from(sellerProfiles)
    .where(eq(sellerProfiles.organizationId, organizationId));
  return profile ?? null;
}

async function requireEditableProfile(db: DbOrTx, organizationId: string): Promise<SellerProfile> {
  const profile = await findProfileForOrg(db, organizationId);
  if (!profile) throw notFound("Seller listing");
  if (profile.status === "suspended") {
    throw conflict("This listing is suspended and cannot be edited.");
  }
  return profile;
}

export async function getSellerListing(
  actor: Actor | null,
  organizationId: string,
): Promise<SellerListing | null> {
  await requirePermission(actor, organizationId, "seller_listing.view");
  const db = getDb();
  const profile = await findProfileForOrg(db, organizationId);
  if (!profile) return null;
  const offerings = await db
    .select()
    .from(serviceOfferings)
    .where(and(eq(serviceOfferings.sellerProfileId, profile.id), eq(serviceOfferings.isActive, true)))
    .orderBy(asc(serviceOfferings.createdAt));
  const [endpoint] = await db
    .select()
    .from(serviceEndpoints)
    .where(eq(serviceEndpoints.sellerProfileId, profile.id));
  return { profile, offerings, endpoint: endpoint ?? null };
}

/** How the organization's listing will look to buyers, whatever its current status. */
export async function getSellerPreview(
  actor: Actor | null,
  organizationId: string,
): Promise<PublicSellerDetail | null> {
  await requirePermission(actor, organizationId, "seller_listing.view");
  const profile = await findProfileForOrg(getDb(), organizationId);
  if (!profile) return null;
  return loadPublicSellerDetail(profile.id);
}

export async function updateSellerListing(
  actor: Actor | null,
  organizationId: string,
  rawInput: unknown,
): Promise<SellerProfile> {
  await requirePermission(actor, organizationId, "seller_listing.manage");
  assertAuthenticated(actor);
  const input = parseInput(sellerListingInput, rawInput);
  return getDb().transaction(async (tx) => {
    const profile = await requireEditableProfile(tx, organizationId);
    const [updated] = await tx
      .update(sellerProfiles)
      .set({
        displayName: input.displayName,
        tagline: input.tagline,
        description: input.description,
        capabilities: [...new Set(input.capabilities)],
      })
      .where(eq(sellerProfiles.id, profile.id))
      .returning();
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId,
        action: "seller_profile.updated",
        entityType: "seller_profile",
        entityId: profile.id,
      },
      tx,
    );
    return updated;
  });
}

export async function saveSellerEndpoint(
  actor: Actor | null,
  organizationId: string,
  rawInput: unknown,
): Promise<ServiceEndpoint> {
  await requirePermission(actor, organizationId, "seller_listing.manage");
  assertAuthenticated(actor);
  const input = parseInput(endpointInput, rawInput);
  return getDb().transaction(async (tx) => {
    const profile = await requireEditableProfile(tx, organizationId);
    const [endpoint] = await tx
      .insert(serviceEndpoints)
      .values({ sellerProfileId: profile.id, url: input.url, protocol: input.protocol })
      .onConflictDoUpdate({
        target: serviceEndpoints.sellerProfileId,
        set: { url: input.url, protocol: input.protocol, updatedAt: new Date() },
      })
      .returning();
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId,
        action: "service_endpoint.saved",
        entityType: "service_endpoint",
        entityId: endpoint.id,
        metadata: { protocol: input.protocol },
      },
      tx,
    );
    return endpoint;
  });
}

export async function createOffering(
  actor: Actor | null,
  organizationId: string,
  rawInput: unknown,
): Promise<ServiceOffering> {
  await requirePermission(actor, organizationId, "seller_listing.manage");
  assertAuthenticated(actor);
  const input = parseInput(offeringInput, rawInput);
  return getDb().transaction(async (tx) => {
    const profile = await requireEditableProfile(tx, organizationId);
    const [offering] = await tx
      .insert(serviceOfferings)
      .values({
        sellerProfileId: profile.id,
        name: input.name,
        description: input.description,
        capability: input.capability,
        billingUnit: input.billingUnit,
        priceMinor: input.priceMinor,
        currency: "USD",
        requiresWeb3: isWeb3Capability(input.capability),
      })
      .returning();
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId,
        action: "service_offering.created",
        entityType: "service_offering",
        entityId: offering.id,
        metadata: { priceMinor: offering.priceMinor, currency: offering.currency },
      },
      tx,
    );
    return offering;
  });
}

/**
 * Remove an offering. It must belong to the caller's own organization's
 * listing. An offering that a buyer's mandate refers to is retired instead of
 * deleted, so existing mandates keep an accurate record of what was permitted.
 */
export async function deleteOffering(
  actor: Actor | null,
  organizationId: string,
  offeringId: string,
): Promise<void> {
  await requirePermission(actor, organizationId, "seller_listing.manage");
  assertAuthenticated(actor);
  if (!isUuid(offeringId)) throw notFound("Offering");
  await getDb().transaction(async (tx) => {
    const profile = await requireEditableProfile(tx, organizationId);
    const [offering] = await tx
      .select({ id: serviceOfferings.id })
      .from(serviceOfferings)
      .where(
        and(eq(serviceOfferings.id, offeringId), eq(serviceOfferings.sellerProfileId, profile.id)),
      );
    if (!offering) throw notFound("Offering");

    const [inUse] = await tx
      .select({ mandateId: mandatePermittedOfferings.mandateId })
      .from(mandatePermittedOfferings)
      .where(eq(mandatePermittedOfferings.serviceOfferingId, offeringId))
      .limit(1);
    if (inUse) {
      await tx
        .update(serviceOfferings)
        .set({ isActive: false })
        .where(eq(serviceOfferings.id, offeringId));
    } else {
      await tx.delete(serviceOfferings).where(eq(serviceOfferings.id, offeringId));
    }
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId,
        action: inUse ? "service_offering.retired" : "service_offering.deleted",
        entityType: "service_offering",
        entityId: offeringId,
      },
      tx,
    );
  });
}

/** What a listing still needs before it can be submitted. Empty means ready. */
export function listingGaps(listing: SellerListing): string[] {
  const gaps: string[] = [];
  if (listing.profile.description.trim().length < 40) {
    gaps.push("Write a description of at least 40 characters.");
  }
  if (listing.profile.capabilities.length === 0) gaps.push("Select at least one capability.");
  if (listing.offerings.filter((o) => o.isActive).length === 0) {
    gaps.push("Add at least one priced service offering.");
  }
  if (!listing.endpoint) gaps.push("Link a service endpoint.");
  return gaps;
}

/**
 * Submit a draft for activation. Activation itself is a platform decision and
 * is not something a seller can perform on their own listing.
 */
export async function submitSellerListing(
  actor: Actor | null,
  organizationId: string,
): Promise<SellerProfile> {
  await requirePermission(actor, organizationId, "seller_listing.submit");
  assertAuthenticated(actor);
  const listing = await getSellerListing(actor, organizationId);
  if (!listing) throw notFound("Seller listing");
  if (listing.profile.status !== "draft") {
    throw conflict("Only a draft listing can be submitted.");
  }
  const gaps = listingGaps(listing);
  if (gaps.length > 0) {
    throw invalid("The listing is not ready to submit.", { _form: gaps });
  }
  return getDb().transaction(async (tx) => {
    const [updated] = await tx
      .update(sellerProfiles)
      .set({ status: "pending_review", submittedAt: new Date() })
      .where(and(eq(sellerProfiles.id, listing.profile.id), eq(sellerProfiles.status, "draft")))
      .returning();
    if (!updated) throw conflict("Only a draft listing can be submitted.");
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId,
        action: "seller_profile.submitted",
        entityType: "seller_profile",
        entityId: updated.id,
        metadata: { from: "draft", to: "pending_review" },
      },
      tx,
    );
    return updated;
  });
}

/** Pull a submitted listing back to draft. */
export async function withdrawSellerListing(
  actor: Actor | null,
  organizationId: string,
): Promise<SellerProfile> {
  await requirePermission(actor, organizationId, "seller_listing.submit");
  assertAuthenticated(actor);
  return getDb().transaction(async (tx) => {
    const profile = await findProfileForOrg(tx, organizationId);
    if (!profile) throw notFound("Seller listing");
    const [updated] = await tx
      .update(sellerProfiles)
      .set({ status: "draft", submittedAt: null })
      .where(and(eq(sellerProfiles.id, profile.id), eq(sellerProfiles.status, "pending_review")))
      .returning();
    if (!updated) throw conflict("Only a listing awaiting review can be withdrawn.");
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId,
        action: "seller_profile.withdrawn",
        entityType: "seller_profile",
        entityId: updated.id,
        metadata: { from: "pending_review", to: "draft" },
      },
      tx,
    );
    return updated;
  });
}
