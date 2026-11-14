import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { completeOnboarding } from "@/server/accounts";
import type { Actor } from "@/server/authz";
import { getPublicSellerBySlug, listPublicSellers } from "@/server/marketplace";
import {
  createOffering,
  getSellerListing,
  getSellerPreview,
  saveSellerEndpoint,
  submitSellerListing,
  updateSellerListing,
  withdrawSellerListing,
} from "@/server/sellers";
import {
  createUser,
  useTestDatabase,
  validEndpoint,
  validListing,
  validOffering,
} from "./support/db";

let db: Db;
let close: () => Promise<void>;

let seller: Actor;
let sellerOrg: string;
let slug: string;
const SECRET_ENDPOINT = "https://secret-endpoint.internal.example/agent";

/** Platform activation, as performed by the operator script. Not reachable from the data layer. */
async function platformActivate(profileSlug: string) {
  await db
    .update(schema.sellerProfiles)
    .set({ status: "active", activatedAt: new Date() })
    .where(eq(schema.sellerProfiles.slug, profileSlug));
}

async function createSeller(label: string, listing: Record<string, unknown>) {
  const user = await createUser(db, label);
  const ws = await completeOnboarding(user, {
    displayName: `${label} person`,
    organizationName: `${label} org`,
    accountType: "business",
    roles: "seller",
  });
  await updateSellerListing(user, ws.organization.id, listing);
  return { user, organizationId: ws.organization.id, slug: ws.sellerProfile!.slug };
}

beforeAll(async () => {
  ({ db, close } = await useTestDatabase());
  const created = await createSeller("acme", validListing);
  seller = created.user;
  sellerOrg = created.organizationId;
  slug = created.slug;
});
afterAll(async () => close());

describe("listing lifecycle", () => {
  it("keeps a draft out of the marketplace", async () => {
    expect(await listPublicSellers()).toEqual([]);
    expect(await getPublicSellerBySlug(slug)).toBeNull();
  });

  it("refuses to submit an incomplete listing and says what is missing", async () => {
    const error = await submitSellerListing(seller, sellerOrg).catch((e) => e);
    expect(error).toMatchObject({ code: "invalid" });
    expect(error.fieldErrors._form).toEqual(
      expect.arrayContaining([
        "Add at least one priced service offering.",
        "Link a service endpoint.",
      ]),
    );
    expect((await getSellerListing(seller, sellerOrg))?.profile.status).toBe("draft");
  });

  it("lets the owner preview a draft that the public cannot see", async () => {
    await saveSellerEndpoint(seller, sellerOrg, { ...validEndpoint, url: SECRET_ENDPOINT });
    await createOffering(seller, sellerOrg, validOffering);
    await createOffering(seller, sellerOrg, {
      ...validOffering,
      name: "Regression suite",
      capability: "regression_testing",
      billingUnit: "per_test_suite",
      priceMinor: 2500,
    });
    const preview = await getSellerPreview(seller, sellerOrg);
    expect(preview?.displayName).toBe(validListing.displayName);
    expect(preview?.status).toBe("draft");
    expect(preview?.offerings).toHaveLength(2);
    expect(await getPublicSellerBySlug(slug)).toBeNull();
  });

  it("moves a complete draft to pending review, which is still not public", async () => {
    const submitted = await submitSellerListing(seller, sellerOrg);
    expect(submitted.status).toBe("pending_review");
    expect(submitted.submittedAt).not.toBeNull();
    expect(await listPublicSellers()).toEqual([]);
    expect(await getPublicSellerBySlug(slug)).toBeNull();
  });

  it("gives sellers no way to activate their own listing", async () => {
    // Submitting again does not advance it, and no input can set the status.
    await expect(submitSellerListing(seller, sellerOrg)).rejects.toMatchObject({ code: "conflict" });
    await updateSellerListing(seller, sellerOrg, {
      ...validListing,
      status: "active",
      isSample: true,
      activatedAt: new Date().toISOString(),
    });
    const listing = await getSellerListing(seller, sellerOrg);
    expect(listing?.profile.status).toBe("pending_review");
    expect(listing?.profile.isSample).toBe(false);
    expect(listing?.profile.activatedAt).toBeNull();
    expect(await listPublicSellers()).toEqual([]);
  });

  it("can be withdrawn back to draft and resubmitted", async () => {
    expect((await withdrawSellerListing(seller, sellerOrg)).status).toBe("draft");
    await expect(withdrawSellerListing(seller, sellerOrg)).rejects.toMatchObject({ code: "conflict" });
    expect((await submitSellerListing(seller, sellerOrg)).status).toBe("pending_review");
  });

  it("appears publicly only once the platform activates it", async () => {
    await platformActivate(slug);
    const listed = await listPublicSellers();
    expect(listed.map((s) => s.slug)).toEqual([slug]);
    expect((await getPublicSellerBySlug(slug))?.displayName).toBe(validListing.displayName);
  });

  it("disappears again when suspended, and can no longer be edited", async () => {
    await db
      .update(schema.sellerProfiles)
      .set({ status: "suspended" })
      .where(eq(schema.sellerProfiles.slug, slug));
    expect(await listPublicSellers()).toEqual([]);
    expect(await getPublicSellerBySlug(slug)).toBeNull();
    await expect(updateSellerListing(seller, sellerOrg, validListing)).rejects.toMatchObject({
      code: "conflict",
    });
    await platformActivate(slug);
  });
});

describe("public listing data", () => {
  it("never contains the endpoint address or internal identifiers", async () => {
    const detail = await getPublicSellerBySlug(slug);
    const list = await listPublicSellers();
    for (const payload of [detail, list]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(SECRET_ENDPOINT);
      expect(serialized).not.toContain("secret-endpoint");
      expect(serialized).not.toContain(sellerOrg);
      expect(serialized).not.toContain(seller.userId);
    }
    expect(detail).not.toHaveProperty("organizationId");
    expect(detail).not.toHaveProperty("createdBy");
    expect(detail).not.toHaveProperty("endpoint");
    expect(detail).not.toHaveProperty("id");
  });

  it("exposes only the endpoint protocol", async () => {
    expect((await getPublicSellerBySlug(slug))?.endpointProtocol).toBe("https_json");
  });

  it("returns prices as integer minor units with the lowest as the starting price", async () => {
    const detail = await getPublicSellerBySlug(slug);
    expect(detail?.offerings.map((o) => o.priceMinor)).toEqual([1500, 2500]);
    for (const offering of detail!.offerings) {
      expect(Number.isInteger(offering.priceMinor)).toBe(true);
      expect(offering.currency).toBe("USD");
    }
    expect(detail?.startingPriceMinor).toBe(1500);
    expect(detail?.offeringCount).toBe(2);
  });

  it("treats malformed slugs as not found", async () => {
    for (const bad of ["", "../etc/passwd", "UPPER", "a b", "x".repeat(80), "';--"]) {
      expect(await getPublicSellerBySlug(bad), bad).toBeNull();
    }
  });
});

describe("marketplace filters", () => {
  let web3Slug: string;

  beforeAll(async () => {
    const web3 = await createSeller("chainworks", {
      displayName: "Chainworks",
      tagline: "Fuzzing for Solidity",
      description: "Runs Foundry fuzz and invariant campaigns and reports findings with evidence.",
      capabilities: ["foundry_fuzz", "invariant_testing"],
      intendedRails: ["goat"],
    });
    web3Slug = web3.slug;
    await createOffering(web3.user, web3.organizationId, {
      ...validOffering,
      name: "Fuzz campaign",
      capability: "foundry_fuzz",
      billingUnit: "per_contract",
      priceMinor: 4500,
    });
    await platformActivate(web3Slug);

    // A third seller that stays a draft must never show up in any filter result.
    await createSeller("hidden-draft", { ...validListing, displayName: "Hidden Draft Co" });
  });

  it("lists all active sellers and no drafts", async () => {
    const slugs = (await listPublicSellers()).map((s) => s.slug).sort();
    expect(slugs).toEqual([slug, web3Slug].sort());
  });

  it("filters by Web3 support", async () => {
    expect((await listPublicSellers({ web3: "yes" })).map((s) => s.slug)).toEqual([web3Slug]);
    expect((await listPublicSellers({ web3: "no" })).map((s) => s.slug)).toEqual([slug]);
  });

  it("filters by capability", async () => {
    expect((await listPublicSellers({ capability: "foundry_fuzz" })).map((s) => s.slug)).toEqual([
      web3Slug,
    ]);
    expect((await listPublicSellers({ capability: "unit_testing" })).map((s) => s.slug)).toEqual([slug]);
    expect(await listPublicSellers({ capability: "slither_static_analysis" })).toEqual([]);
  });

  it("searches names, descriptions and service names, never drafts", async () => {
    expect((await listPublicSellers({ query: "solidity" })).map((s) => s.slug)).toEqual([web3Slug]);
    expect((await listPublicSellers({ query: "REGRESSION SUITE" })).map((s) => s.slug)).toEqual([slug]);
    expect(await listPublicSellers({ query: "hidden draft" })).toEqual([]);
    expect(await listPublicSellers({ query: "no such agent anywhere" })).toEqual([]);
  });

  it("marks web3 offerings from their capability, not from seller input", async () => {
    const detail = await getPublicSellerBySlug(web3Slug);
    expect(detail?.supportsWeb3).toBe(true);
    expect(detail?.offerings[0].requiresWeb3).toBe(true);
    expect((await getPublicSellerBySlug(slug))?.supportsWeb3).toBe(false);
  });
});

describe("listing input validation", () => {
  it("rejects unknown capabilities and rails", async () => {
    await expect(
      updateSellerListing(seller, sellerOrg, { ...validListing, capabilities: ["mind_reading"] }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      updateSellerListing(seller, sellerOrg, { ...validListing, intendedRails: ["paypal"] }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("requires an https endpoint without embedded credentials", async () => {
    for (const url of [
      "http://agent.example/api",
      "ftp://agent.example",
      "javascript:alert(1)",
      "https://user:pass@agent.example/api",
      "not a url",
    ]) {
      await expect(
        saveSellerEndpoint(seller, sellerOrg, { ...validEndpoint, url }),
        url,
      ).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("rejects fractional, negative and absurd prices", async () => {
    for (const priceMinor of [15.5, -1, 100_000_001, Number.NaN]) {
      await expect(
        createOffering(seller, sellerOrg, { ...validOffering, priceMinor }),
        String(priceMinor),
      ).rejects.toMatchObject({ code: "invalid" });
    }
  });

  it("is backed by a database constraint against negative prices", async () => {
    const listing = await getSellerListing(seller, sellerOrg);
    await expect(
      db.insert(schema.serviceOfferings).values({
        sellerProfileId: listing!.profile.id,
        name: "Bad",
        capability: "unit_testing",
        billingUnit: "per_run",
        priceMinor: -100,
      }),
    ).rejects.toThrow();
  });
});
