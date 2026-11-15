import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { completeOnboarding } from "@/server/accounts";
import { assertAgentMayContactSeller, checkAgentCommunication } from "@/server/agent-gate";
import type { Actor } from "@/server/authz";
import {
  authorizeEngagement,
  authorizeFunding,
  cancelEngagement,
  createEngagement,
  getEngagementDetail,
  listEngagements,
  provisionEngagementWallet,
  saveMandateDraft,
} from "@/server/engagements";
import { createProject, deleteProject } from "@/server/projects";
import {
  createOffering,
  deleteOffering,
  getSellerListing,
  saveSellerEndpoint,
  updateSellerListing,
} from "@/server/sellers";
import { depositSimulatedFunds, getWalletOverview } from "@/server/wallets";
import type { WalletProvider } from "@/server/wallets/provider";
import { setWalletProvider } from "@/server/wallets/registry";
import { SimulatedWalletProvider } from "@/server/wallets/simulated";
import {
  addMember,
  createUser,
  platformActivate,
  useTestDatabase,
  validEndpoint,
  validListing,
  validOffering,
  validProject,
} from "./support/db";

let db: Db;
let close: () => Promise<void>;

type Seller = { owner: Actor; org: string; slug: string; id: string; offeringIds: string[] };
type Buyer = { owner: Actor; org: string; projectId: string };

let acme: Buyer;
let acmeAdmin: Actor;
let acmeMember: Actor;
let globex: Buyer;
let alpha: Seller;
let beta: Seller;

const MISSING_ID = "00000000-0000-4000-8000-000000000000";

async function createSeller(label: string, rails: string[] = ["goat", "qatom"]): Promise<Seller> {
  const owner = await createUser(db, `${label}-owner`);
  const ws = await completeOnboarding(owner, {
    displayName: `${label} owner`,
    organizationName: `${label} agents`,
    accountType: "business",
    roles: "seller",
  });
  const org = ws.organization.id;
  await updateSellerListing(owner, org, {
    ...validListing,
    displayName: `${label} agents`,
    intendedRails: rails,
  });
  await saveSellerEndpoint(owner, org, validEndpoint);
  const first = await createOffering(owner, org, validOffering);
  const second = await createOffering(owner, org, {
    ...validOffering,
    name: "Regression suite",
    capability: "regression_testing",
    priceMinor: 2500,
  });
  const slug = ws.sellerProfile!.slug;
  await platformActivate(db, slug);
  return { owner, org, slug, id: ws.sellerProfile!.id, offeringIds: [first.id, second.id] };
}

async function createBuyer(label: string): Promise<Buyer> {
  const owner = await createUser(db, `${label}-owner`);
  const ws = await completeOnboarding(owner, {
    displayName: `${label} owner`,
    organizationName: `${label} software`,
    accountType: "business",
    roles: "buyer",
  });
  const project = await createProject(owner, ws.organization.id, validProject);
  return { owner, org: ws.organization.id, projectId: project.id };
}

function mandate(seller: Seller, overrides: Record<string, unknown> = {}) {
  return {
    rail: "goat",
    totalBudget: "100",
    perTransactionLimit: "25",
    offeringIds: seller.offeringIds,
    scope: "Run the unit and regression suites against the main branch.",
    expiresInDays: 30,
    ...overrides,
  };
}

const funding = (amount: string, key: string = randomUUID()) => ({
  amount,
  idempotencyKey: key,
  confirmed: true,
});

/** A selected engagement with a saved draft mandate. */
async function drafted(buyer: Buyer, seller: Seller, overrides: Record<string, unknown> = {}) {
  const engagement = await createEngagement(buyer.owner, buyer.org, {
    sellerSlug: seller.slug,
    projectId: buyer.projectId,
  });
  await saveMandateDraft(buyer.owner, engagement.id, mandate(seller, overrides));
  return engagement.id;
}

/** An authorized engagement with a provisioned, unfunded wallet. */
async function awaitingFunding(buyer: Buyer, seller: Seller, overrides: Record<string, unknown> = {}) {
  const id = await drafted(buyer, seller, overrides);
  await authorizeEngagement(buyer.owner, id, { confirmed: true });
  await provisionEngagementWallet(buyer.owner, id);
  return id;
}

async function state(id: string) {
  const [row] = await db.select().from(schema.engagements).where(eq(schema.engagements.id, id));
  return row.state;
}

async function walletOf(id: string) {
  const [row] = await db
    .select()
    .from(schema.engagementWallets)
    .where(eq(schema.engagementWallets.engagementId, id));
  return row;
}

async function masterBalance(org: string, rail: "goat" | "qatom") {
  const [row] = await db
    .select()
    .from(schema.masterWalletAccounts)
    .where(
      and(
        eq(schema.masterWalletAccounts.organizationId, org),
        eq(schema.masterWalletAccounts.rail, rail),
      ),
    );
  return row?.balanceUnits ?? 0n;
}

beforeAll(async () => {
  ({ db, close } = await useTestDatabase());
  alpha = await createSeller("alpha");
  beta = await createSeller("beta", ["qatom"]);
  acme = await createBuyer("acme");
  globex = await createBuyer("globex");
  acmeAdmin = await createUser(db, "acme-admin");
  acmeMember = await createUser(db, "acme-member");
  await addMember(db, acme.org, acmeAdmin.userId, "admin");
  await addMember(db, acme.org, acmeMember.userId, "member");
  await depositSimulatedFunds(acme.owner, acme.org, { rail: "goat", amount: "1000" });
});
afterAll(async () => close());

describe("selecting a seller", () => {
  it("creates the engagement with the human-chosen seller and nothing else", async () => {
    const engagement = await createEngagement(acme.owner, acme.org, {
      sellerSlug: alpha.slug,
      projectId: acme.projectId,
    });
    expect(engagement.state).toBe("SELLER_SELECTED");
    expect(engagement.sellerProfileId).toBe(alpha.id);
    expect(engagement.rail).toBeNull();

    const detail = await getEngagementDetail(acme.owner, engagement.id);
    expect(detail.events.map((e) => e.toState)).toEqual(["DISCOVERING", "SELLER_SELECTED"]);
    expect(detail.mandate).toBeNull();
    expect(detail.wallet).toBeNull();
    expect(detail.agent).toBeNull();
    expect(await checkAgentCommunication(engagement.id, alpha.id)).toMatchObject({ allowed: false });
  });

  it("only accepts an active listing and the caller's own project", async () => {
    const hidden = await createUser(db, "hidden-seller");
    const ws = await completeOnboarding(hidden, {
      displayName: "Hidden",
      organizationName: "Hidden draft seller",
      accountType: "business",
      roles: "seller",
    });
    await expect(
      createEngagement(acme.owner, acme.org, {
        sellerSlug: ws.sellerProfile!.slug,
        projectId: acme.projectId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      createEngagement(acme.owner, acme.org, { sellerSlug: alpha.slug, projectId: globex.projectId }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      createEngagement(acme.owner, acme.org, { sellerSlug: "no-such-seller", projectId: acme.projectId }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("lets admins draft but not plain members, and never another organization", async () => {
    const byAdmin = await createEngagement(acmeAdmin, acme.org, {
      sellerSlug: alpha.slug,
      projectId: acme.projectId,
    });
    expect(byAdmin.state).toBe("SELLER_SELECTED");
    await expect(
      createEngagement(acmeMember, acme.org, { sellerSlug: alpha.slug, projectId: acme.projectId }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      createEngagement(globex.owner, acme.org, { sellerSlug: alpha.slug, projectId: acme.projectId }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("requires the organization to be a buyer", async () => {
    await expect(
      createEngagement(alpha.owner, alpha.org, { sellerSlug: beta.slug, projectId: acme.projectId }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("the spending mandate", () => {
  it("is saved as a draft without authorizing anything", async () => {
    const id = await drafted(acme, alpha);
    const detail = await getEngagementDetail(acme.owner, id);
    expect(detail.engagement.state).toBe("SELLER_SELECTED");
    expect(detail.engagement.rail).toBe("goat");
    expect(detail.mandate).toMatchObject({
      status: "draft",
      totalAuthorizedUnits: 10000n,
      perTransactionLimitUnits: 2500n,
      asset: { code: "SIM-USD", decimals: 2 },
    });
    expect(detail.mandate?.permittedOfferingIds.sort()).toEqual([...alpha.offeringIds].sort());
    expect(detail.wallet).toBeNull();
    expect(detail.agent).toBeNull();
  });

  it("can be revised until it is authorized, and always settles on GOAT", async () => {
    const id = await drafted(acme, alpha);
    // The network is not part of the form: leaving it out changes nothing.
    const { rail: _unused, ...withoutRail } = mandate(alpha, { totalBudget: "250.50" });
    await saveMandateDraft(acme.owner, id, withoutRail);
    const detail = await getEngagementDetail(acme.owner, id);
    expect(detail.engagement.rail).toBe("goat");
    expect(detail.mandate?.totalAuthorizedUnits).toBe(25050n);
    expect(detail.mandate?.asset.code).toBe("SIM-USD");
  });

  it("cannot be pointed at any other payment network", async () => {
    const id = await drafted(acme, alpha);
    for (const rail of ["qatom", "paypal", ""]) {
      const error = await saveMandateDraft(acme.owner, id, mandate(alpha, { rail })).catch((e) => e);
      expect(error.fieldErrors.rail[0], rail).toContain("GOAT Network");
    }
    expect((await getEngagementDetail(acme.owner, id)).engagement.rail).toBe("goat");
  });

  it("rejects limits and services that do not make sense", async () => {
    const engagement = await createEngagement(acme.owner, acme.org, {
      sellerSlug: beta.slug,
      projectId: acme.projectId,
    });
    const attempt = (overrides: Record<string, unknown>) =>
      saveMandateDraft(acme.owner, engagement.id, mandate(beta, overrides)).catch((e) => e);

    expect((await attempt({ totalBudget: "0" })).fieldErrors.totalBudget).toBeDefined();
    expect((await attempt({ totalBudget: "12.345" })).fieldErrors.totalBudget).toBeDefined();
    expect((await attempt({ totalBudget: "-5" })).fieldErrors.totalBudget).toBeDefined();
    expect((await attempt({ perTransactionLimit: "150" })).fieldErrors.perTransactionLimit).toBeDefined();
    expect((await attempt({ offeringIds: [] })).fieldErrors.offeringIds).toBeDefined();
    // Another seller's services cannot be permitted under this seller's mandate.
    expect((await attempt({ offeringIds: alpha.offeringIds })).fieldErrors.offeringIds).toBeDefined();
    expect((await attempt({ expiresInDays: 0 })).fieldErrors.expiresInDays).toBeDefined();
    expect((await attempt({ expiresInDays: 4000 })).fieldErrors.expiresInDays).toBeDefined();
    expect((await attempt({ scope: "x" })).fieldErrors.scope).toBeDefined();

    expect((await getEngagementDetail(acme.owner, engagement.id)).mandate).toBeNull();
  });
});

describe("authorizing the engagement", () => {
  it("needs an explicit confirmation and a configured mandate", async () => {
    const bare = await createEngagement(acme.owner, acme.org, {
      sellerSlug: alpha.slug,
      projectId: acme.projectId,
    });
    await expect(authorizeEngagement(acme.owner, bare.id, { confirmed: true })).rejects.toMatchObject({
      code: "invalid",
    });

    const id = await drafted(acme, alpha);
    for (const confirmed of [false, undefined, "true", 1]) {
      await expect(authorizeEngagement(acme.owner, id, { confirmed })).rejects.toMatchObject({
        code: "invalid",
      });
    }
    expect(await state(id)).toBe("SELLER_SELECTED");
  });

  it("is reserved for the owner", async () => {
    const id = await drafted(acme, alpha);
    await expect(authorizeEngagement(acmeAdmin, id, { confirmed: true })).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(authorizeEngagement(acmeMember, id, { confirmed: true })).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await state(id)).toBe("SELLER_SELECTED");
  });

  it("locks the mandate, creates an inactive agent, and moves no funds", async () => {
    const before = await masterBalance(acme.org, "goat");
    const id = await drafted(acme, alpha);
    const authorized = await authorizeEngagement(acme.owner, id, { confirmed: true });

    expect(authorized.state).toBe("AUTHORIZED");
    expect(authorized.authorizedBy).toBe(acme.owner.userId);
    expect(authorized.expiresAt).toBeInstanceOf(Date);

    const detail = await getEngagementDetail(acme.owner, id);
    expect(detail.mandate?.status).toBe("authorized");
    expect(detail.agent?.status).toBe("inactive");
    expect(detail.wallet).toBeNull();
    expect(await masterBalance(acme.org, "goat")).toBe(before);

    await expect(saveMandateDraft(acme.owner, id, mandate(alpha, { totalBudget: "9999" }))).rejects.toMatchObject(
      { code: "conflict" },
    );
    await expect(authorizeEngagement(acme.owner, id, { confirmed: true })).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await getEngagementDetail(acme.owner, id)).mandate?.totalAuthorizedUnits).toBe(10000n);
  });
});

describe("provisioning the wallet", () => {
  it("gives the engagement its own empty wallet and waits for funding", async () => {
    const before = await masterBalance(acme.org, "goat");
    const id = await drafted(acme, alpha);
    await expect(provisionEngagementWallet(acme.owner, id)).rejects.toMatchObject({ code: "conflict" });

    await authorizeEngagement(acme.owner, id, { confirmed: true });
    await expect(provisionEngagementWallet(acmeAdmin, id)).rejects.toMatchObject({ code: "forbidden" });
    const provisioned = await provisionEngagementWallet(acme.owner, id);

    expect(provisioned.state).toBe("AWAITING_FUNDING");
    const detail = await getEngagementDetail(acme.owner, id);
    expect(detail.events.map((e) => e.toState)).toEqual([
      "DISCOVERING",
      "SELLER_SELECTED",
      "AUTHORIZED",
      "WALLET_PROVISIONED",
      "AWAITING_FUNDING",
    ]);
    expect(detail.wallet).toMatchObject({
      status: "awaiting_funding",
      balanceUnits: 0n,
      isSimulated: true,
      asset: { code: "SIM-USD", decimals: 2 },
    });
    expect(detail.agent?.status).toBe("inactive");
    expect(await masterBalance(acme.org, "goat")).toBe(before);
    await expect(provisionEngagementWallet(acme.owner, id)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("authorizing funding", () => {
  it("is a separate, confirmed, owner-only decision", async () => {
    const id = await awaitingFunding(acme, alpha);
    await expect(
      authorizeFunding(acme.owner, id, { ...funding("50"), confirmed: false }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(authorizeFunding(acmeAdmin, id, funding("50"))).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(authorizeFunding(acmeMember, id, funding("50"))).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await state(id)).toBe("AWAITING_FUNDING");
    expect((await walletOf(id)).balanceUnits).toBe(0n);
  });

  it("moves the exact amount, records it, and activates the engagement", async () => {
    const id = await awaitingFunding(acme, alpha);
    const before = await masterBalance(acme.org, "goat");
    const outcome = await authorizeFunding(acme.owner, id, funding("60.25"));

    expect(outcome.replayed).toBe(false);
    expect(outcome.funding).toMatchObject({ status: "executed", amountUnits: 6025n, isSimulated: true });
    expect(outcome.engagement.state).toBe("ACTIVE");
    expect(await masterBalance(acme.org, "goat")).toBe(before - 6025n);

    const detail = await getEngagementDetail(acme.owner, id);
    expect(detail.wallet).toMatchObject({ status: "active", balanceUnits: 6025n });
    expect(detail.agent?.status).toBe("active");
    // Funding is not budget: the mandate is exactly as authorized.
    expect(detail.mandate?.totalAuthorizedUnits).toBe(10000n);

    const ledger = await db
      .select()
      .from(schema.walletLedgerEntries)
      .where(eq(schema.walletLedgerEntries.fundingAuthorizationId, outcome.funding.id));
    expect(ledger.map((l) => l.deltaUnits).sort()).toEqual([-6025n, 6025n].sort());
  });

  it("does not let a budget stand in for money, or money for a budget", async () => {
    const poor = await createBuyer("penniless");
    const id = await awaitingFunding(poor, alpha, { totalBudget: "500" });
    // A 500 budget with an empty master account funds nothing.
    await expect(authorizeFunding(poor.owner, id, funding("10"))).rejects.toMatchObject({
      code: "invalid",
    });
    expect(await state(id)).toBe("AWAITING_FUNDING");

    // Funding above the budget is allowed and leaves the budget unchanged.
    await depositSimulatedFunds(poor.owner, poor.org, { rail: "goat", amount: "900" });
    await authorizeFunding(poor.owner, id, funding("900"));
    const detail = await getEngagementDetail(poor.owner, id);
    expect(detail.wallet?.balanceUnits).toBe(90000n);
    expect(detail.mandate?.totalAuthorizedUnits).toBe(50000n);
  });

  it("refuses more than the master account holds", async () => {
    const id = await awaitingFunding(acme, alpha);
    const before = await masterBalance(acme.org, "goat");
    const error = await authorizeFunding(acme.owner, id, funding("999999")).catch((e) => e);
    expect(error.fieldErrors.amount).toBeDefined();
    expect(await masterBalance(acme.org, "goat")).toBe(before);
    expect((await walletOf(id)).balanceUnits).toBe(0n);
    for (const bad of ["0", "-1", "abc", "1.234"]) {
      await expect(authorizeFunding(acme.owner, id, funding(bad))).rejects.toMatchObject({
        code: "invalid",
      });
    }
  });

  it("funds once when the same authorization is submitted twice", async () => {
    const id = await awaitingFunding(acme, alpha);
    const before = await masterBalance(acme.org, "goat");
    const key = randomUUID();
    const first = await authorizeFunding(acme.owner, id, funding("40", key));
    const second = await authorizeFunding(acme.owner, id, funding("40", key));
    const [third, fourth] = await Promise.all([
      authorizeFunding(acme.owner, id, funding("40", key)),
      authorizeFunding(acme.owner, id, funding("40", key)),
    ]);

    expect(first.replayed).toBe(false);
    for (const repeat of [second, third, fourth]) {
      expect(repeat.replayed).toBe(true);
      expect(repeat.funding.id).toBe(first.funding.id);
    }
    expect((await walletOf(id)).balanceUnits).toBe(4000n);
    expect(await masterBalance(acme.org, "goat")).toBe(before - 4000n);
  });

  it("cannot reuse one engagement's authorization key on another", async () => {
    const a = await awaitingFunding(acme, alpha);
    const b = await awaitingFunding(acme, alpha);
    const key = randomUUID();
    await authorizeFunding(acme.owner, a, funding("10", key));
    await expect(authorizeFunding(acme.owner, b, funding("10", key))).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await walletOf(b)).balanceUnits).toBe(0n);
  });

  it("cannot overdraw the master account with simultaneous authorizations", async () => {
    const buyer = await createBuyer("racer");
    await depositSimulatedFunds(buyer.owner, buyer.org, { rail: "goat", amount: "100" });
    const a = await awaitingFunding(buyer, alpha);
    const b = await awaitingFunding(buyer, alpha);

    const results = await Promise.allSettled([
      authorizeFunding(buyer.owner, a, funding("80")),
      authorizeFunding(buyer.owner, b, funding("80")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await masterBalance(buyer.org, "goat")).toBe(2000n);
    const total = (await walletOf(a)).balanceUnits + (await walletOf(b)).balanceUnits;
    expect(total).toBe(8000n);
  });

  it("treats a later top-up as another separate authorization", async () => {
    const id = await awaitingFunding(acme, alpha);
    await authorizeFunding(acme.owner, id, funding("20"));
    const topUp = await authorizeFunding(acme.owner, id, funding("15"));
    expect(topUp.engagement.state).toBe("ACTIVE");
    expect((await walletOf(id)).balanceUnits).toBe(3500n);
    const detail = await getEngagementDetail(acme.owner, id);
    expect(detail.fundings).toHaveLength(2);
    expect(detail.events.filter((e) => e.toState === "ACTIVE")).toHaveLength(1);
  });

  it("is refused before a wallet exists", async () => {
    const id = await drafted(acme, alpha);
    await expect(authorizeFunding(acme.owner, id, funding("10"))).rejects.toMatchObject({
      code: "conflict",
    });
    await authorizeEngagement(acme.owner, id, { confirmed: true });
    await expect(authorizeFunding(acme.owner, id, funding("10"))).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("is refused when the seller's listing is no longer active", async () => {
    const gone = await createSeller("gone");
    const id = await awaitingFunding(acme, gone);
    const before = await masterBalance(acme.org, "goat");
    await db
      .update(schema.sellerProfiles)
      .set({ status: "suspended" })
      .where(eq(schema.sellerProfiles.id, gone.id));
    await expect(authorizeFunding(acme.owner, id, funding("10"))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await masterBalance(acme.org, "goat")).toBe(before);
    expect(await state(id)).toBe("AWAITING_FUNDING");
  });
});

describe("wallet isolation", () => {
  it("gives every engagement a different wallet, even with the same seller", async () => {
    const first = await awaitingFunding(acme, alpha);
    const second = await awaitingFunding(acme, alpha);
    const a = await walletOf(first);
    const b = await walletOf(second);
    expect(a.id).not.toBe(b.id);
    expect(a.providerRef).not.toBe(b.providerRef);
    expect(a.engagementId).toBe(first);
    expect(b.engagementId).toBe(second);
  });

  it("funds one engagement without touching another", async () => {
    const first = await awaitingFunding(acme, alpha);
    const second = await awaitingFunding(acme, alpha);
    await authorizeFunding(acme.owner, first, funding("30"));
    expect((await walletOf(first)).balanceUnits).toBe(3000n);
    expect((await walletOf(second)).balanceUnits).toBe(0n);
    expect(await state(second)).toBe("AWAITING_FUNDING");
    expect(await checkAgentCommunication(second, alpha.id)).toMatchObject({ allowed: false });
  });

  it("is enforced by the database: one wallet per engagement, never reassigned", async () => {
    const first = await awaitingFunding(acme, alpha);
    const second = await awaitingFunding(acme, alpha);
    const wallet = await walletOf(first);

    // A second wallet for the same engagement.
    await expect(
      db.insert(schema.engagementWallets).values({
        engagementId: first,
        organizationId: acme.org,
        rail: "goat",
        asset: "SIM-USD",
        assetDecimals: 2,
        provider: "simulated",
        providerRef: "sim-wallet:goat:duplicate",
      }),
    ).rejects.toThrow();
    // Handing a wallet to another engagement.
    await expect(
      db
        .update(schema.engagementWallets)
        .set({ engagementId: second })
        .where(eq(schema.engagementWallets.id, wallet.id)),
    ).rejects.toThrow();
    // Reusing a wallet reference.
    const third = await drafted(acme, alpha);
    await authorizeEngagement(acme.owner, third, { confirmed: true });
    await expect(
      db.insert(schema.engagementWallets).values({
        engagementId: third,
        organizationId: acme.org,
        rail: "goat",
        asset: "SIM-USD",
        assetDecimals: 2,
        provider: wallet.provider,
        providerRef: wallet.providerRef,
      }),
    ).rejects.toThrow();
    expect((await walletOf(first)).engagementId).toBe(first);
  });

  it("is enforced by the database: a funding record cannot name another engagement's wallet", async () => {
    const first = await awaitingFunding(acme, alpha);
    const second = await awaitingFunding(acme, alpha);
    const walletOfFirst = await walletOf(first);
    const [master] = await db
      .select()
      .from(schema.masterWalletAccounts)
      .where(eq(schema.masterWalletAccounts.organizationId, acme.org));

    await expect(
      db.insert(schema.fundingAuthorizations).values({
        engagementId: second,
        engagementWalletId: walletOfFirst.id,
        masterWalletAccountId: master.id,
        rail: "goat",
        asset: "SIM-USD",
        amountUnits: 100n,
        idempotencyKey: randomUUID(),
        authorizedBy: acme.owner.userId,
      }),
    ).rejects.toThrow();
  });

  it("keeps the wallet's funds out of reach of other organizations", async () => {
    const id = await awaitingFunding(acme, alpha);
    await authorizeFunding(acme.owner, id, funding("25"));
    for (const outsider of [globex.owner, alpha.owner, beta.owner]) {
      await expect(getEngagementDetail(outsider, id)).rejects.toMatchObject({ code: "not_found" });
      await expect(authorizeFunding(outsider, id, funding("5"))).rejects.toMatchObject({
        code: "not_found",
      });
      await expect(cancelEngagement(outsider, id)).rejects.toMatchObject({ code: "not_found" });
    }
    expect(await getWalletOverview(globex.owner, globex.org)).toMatchObject({ wallets: [] });
    await expect(getWalletOverview(globex.owner, acme.org)).rejects.toMatchObject({ code: "forbidden" });
    expect((await walletOf(id)).balanceUnits).toBe(2500n);
  });
});

/**
 * Qatom was once offered as a simulated payment rail. Accounts from that time
 * are kept for their history, and must stay sealed off from everything new.
 */
async function legacyMasterAccount(org: string, balanceUnits: bigint) {
  const [account] = await db
    .insert(schema.masterWalletAccounts)
    .values({
      organizationId: org,
      rail: "qatom",
      asset: "USD-TDN",
      assetDecimals: 2,
      provider: "simulated",
      providerRef: `sim-master:qatom:${randomUUID()}`,
      balanceUnits,
    })
    .returning();
  return account;
}

describe("rail separation", () => {
  it("never funds an engagement from an account on another rail", async () => {
    const buyer = await createBuyer("two-rails");
    await legacyMasterAccount(buyer.org, 50000n);
    const engagement = await awaitingFunding(buyer, beta);

    const error = await authorizeFunding(buyer.owner, engagement, funding("10")).catch((e) => e);
    expect(error.fieldErrors.amount[0]).toContain("0.00 USD");
    expect(await masterBalance(buyer.org, "qatom")).toBe(50000n);
    expect((await walletOf(engagement)).balanceUnits).toBe(0n);

    await depositSimulatedFunds(buyer.owner, buyer.org, { amount: "40" });
    await authorizeFunding(buyer.owner, engagement, funding("40"));
    expect(await masterBalance(buyer.org, "qatom")).toBe(50000n);
    expect(await masterBalance(buyer.org, "goat")).toBe(0n);
    expect((await walletOf(engagement)).rail).toBe("goat");

    const overview = await getWalletOverview(buyer.owner, buyer.org);
    const legacy = overview.rails.find((r) => r.rail === "qatom")!;
    const goat = overview.rails.find((r) => r.rail === "goat")!;
    expect(legacy).toMatchObject({ retired: true, unallocatedUnits: 50000n, allocatedUnits: 0n });
    expect(goat).toMatchObject({ retired: false, unallocatedUnits: 0n, allocatedUnits: 4000n });
  });

  it("creates nothing new on the retired rail", async () => {
    const buyer = await createBuyer("retired-rail");
    await expect(
      depositSimulatedFunds(buyer.owner, buyer.org, { rail: "qatom", amount: "500" }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(
      await db
        .select()
        .from(schema.masterWalletAccounts)
        .where(eq(schema.masterWalletAccounts.organizationId, buyer.org)),
    ).toEqual([]);
    // With no history on it, the retired rail is not shown at all.
    const overview = await getWalletOverview(buyer.owner, buyer.org);
    expect(overview.rails.map((r) => r.rail)).toEqual(["goat"]);
  });

  it("is enforced by the database: wallet, master account and funding share one rail", async () => {
    const buyer = await createBuyer("rail-db");
    const legacyMaster = await legacyMasterAccount(buyer.org, 5000n);
    const engagement = await awaitingFunding(buyer, beta);
    const wallet = await walletOf(engagement);

    // An account on one rail funding a wallet on the other, labelled either way.
    for (const rail of ["goat", "qatom"] as const) {
      await expect(
        db.insert(schema.fundingAuthorizations).values({
          engagementId: engagement,
          engagementWalletId: wallet.id,
          masterWalletAccountId: legacyMaster.id,
          rail,
          asset: "SIM-USD",
          amountUnits: 100n,
          idempotencyKey: randomUUID(),
          authorizedBy: buyer.owner.userId,
        }),
      ).rejects.toThrow();
    }
    // A wallet on a different rail from its engagement.
    const authorized = await drafted(buyer, alpha);
    await authorizeEngagement(buyer.owner, authorized, { confirmed: true });
    await expect(
      db.insert(schema.engagementWallets).values({
        engagementId: authorized,
        organizationId: buyer.org,
        rail: "qatom",
        asset: "USD-TDN",
        assetDecimals: 2,
        provider: "simulated",
        providerRef: "sim-wallet:qatom:wrong-rail",
      }),
    ).rejects.toThrow();
  });
});

describe("what cannot be changed", () => {
  it("fixes the seller for the life of the engagement", async () => {
    const id = await drafted(acme, alpha);
    await expect(
      db.update(schema.engagements).set({ sellerProfileId: beta.id }).where(eq(schema.engagements.id, id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.spendingMandates)
        .set({ sellerProfileId: beta.id })
        .where(eq(schema.spendingMandates.engagementId, id)),
    ).rejects.toThrow();
    const [row] = await db.select().from(schema.engagements).where(eq(schema.engagements.id, id));
    expect(row.sellerProfileId).toBe(alpha.id);
  });

  it("fixes the rail once the engagement is authorized", async () => {
    const id = await drafted(acme, alpha);
    await authorizeEngagement(acme.owner, id, { confirmed: true });
    await expect(
      db.update(schema.engagements).set({ rail: "qatom" }).where(eq(schema.engagements.id, id)),
    ).rejects.toThrow();
  });

  it("keeps an engagement in its organization and project", async () => {
    const id = await drafted(acme, alpha);
    await expect(
      db
        .update(schema.engagements)
        .set({ organizationId: globex.org })
        .where(eq(schema.engagements.id, id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.engagements)
        .set({ projectId: globex.projectId })
        .where(eq(schema.engagements.id, id)),
    ).rejects.toThrow();
  });

  it("cannot reach ACTIVE in the database without being authorized first", async () => {
    const id = await drafted(acme, alpha);
    await expect(
      db.update(schema.engagements).set({ state: "ACTIVE" }).where(eq(schema.engagements.id, id)),
    ).rejects.toThrow();
    expect(await state(id)).toBe("SELLER_SELECTED");
  });
});

describe("agent communication gate", () => {
  it("stays shut at every step until the engagement is active", async () => {
    const id = await drafted(acme, alpha);
    const shut = async (label: string) => {
      const gate = await checkAgentCommunication(id, alpha.id);
      expect(gate.allowed, label).toBe(false);
      await expect(assertAgentMayContactSeller(id, alpha.id), label).rejects.toMatchObject({
        code: "forbidden",
      });
    };
    await shut("SELLER_SELECTED");
    await authorizeEngagement(acme.owner, id, { confirmed: true });
    await shut("AUTHORIZED");
    await provisionEngagementWallet(acme.owner, id);
    await shut("AWAITING_FUNDING");

    await authorizeFunding(acme.owner, id, funding("10"));
    expect(await checkAgentCommunication(id, alpha.id)).toEqual({ allowed: true });
    await expect(assertAgentMayContactSeller(id, alpha.id)).resolves.toBeUndefined();
  });

  it("opens only for the seller the buyer selected", async () => {
    const id = await awaitingFunding(acme, alpha);
    await authorizeFunding(acme.owner, id, funding("10"));
    expect(await checkAgentCommunication(id, beta.id)).toMatchObject({ allowed: false });
    expect(await checkAgentCommunication(id, MISSING_ID)).toMatchObject({ allowed: false });
    expect(await checkAgentCommunication(MISSING_ID, alpha.id)).toMatchObject({ allowed: false });
    expect(await checkAgentCommunication("not-a-uuid", alpha.id)).toMatchObject({ allowed: false });
  });

  it("shuts again on cancellation, on the deadline, and if the agent or wallet is suspended", async () => {
    const cancelled = await awaitingFunding(acme, alpha);
    await authorizeFunding(acme.owner, cancelled, funding("10"));
    await cancelEngagement(acme.owner, cancelled);
    expect(await checkAgentCommunication(cancelled, alpha.id)).toMatchObject({ allowed: false });

    const active = await awaitingFunding(acme, alpha);
    await authorizeFunding(acme.owner, active, funding("10"));
    const afterDeadline = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000);
    expect(await checkAgentCommunication(active, alpha.id, afterDeadline)).toMatchObject({
      allowed: false,
    });

    await db
      .update(schema.purchasingAgents)
      .set({ status: "suspended" })
      .where(eq(schema.purchasingAgents.engagementId, active));
    expect(await checkAgentCommunication(active, alpha.id)).toMatchObject({ allowed: false });
    await db
      .update(schema.purchasingAgents)
      .set({ status: "active" })
      .where(eq(schema.purchasingAgents.engagementId, active));
    expect(await checkAgentCommunication(active, alpha.id)).toEqual({ allowed: true });
    await db
      .update(schema.engagementWallets)
      .set({ status: "suspended" })
      .where(eq(schema.engagementWallets.engagementId, active));
    expect(await checkAgentCommunication(active, alpha.id)).toMatchObject({ allowed: false });
  });
});

describe("the seller's side", () => {
  it("cannot see, authorize, fund, activate or cancel a buyer's engagement", async () => {
    const id = await drafted(acme, alpha);
    await expect(getEngagementDetail(alpha.owner, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(saveMandateDraft(alpha.owner, id, mandate(alpha, { totalBudget: "99999" }))).rejects.toMatchObject(
      { code: "not_found" },
    );
    await expect(authorizeEngagement(alpha.owner, id, { confirmed: true })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(provisionEngagementWallet(alpha.owner, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(authorizeFunding(alpha.owner, id, funding("10"))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(cancelEngagement(alpha.owner, id)).rejects.toMatchObject({ code: "not_found" });

    expect(await state(id)).toBe("SELLER_SELECTED");
    expect((await getEngagementDetail(acme.owner, id)).mandate?.totalAuthorizedUnits).toBe(10000n);
    expect(await listEngagements(alpha.owner, alpha.org)).toEqual([]);
  });

  it("retires rather than deletes a service that a buyer's mandate refers to", async () => {
    const seller = await createSeller("retiring");
    const id = await drafted(acme, seller);
    await deleteOffering(seller.owner, seller.org, seller.offeringIds[0]);

    const [offering] = await db
      .select()
      .from(schema.serviceOfferings)
      .where(eq(schema.serviceOfferings.id, seller.offeringIds[0]));
    expect(offering.isActive).toBe(false);
    expect((await getSellerListing(seller.owner, seller.org))?.offerings).toHaveLength(1);
    // The buyer must review the mandate before authorizing: a retired service cannot be bought.
    await expect(authorizeEngagement(acme.owner, id, { confirmed: true })).rejects.toMatchObject({
      code: "invalid",
    });
  });
});

describe("ending an engagement", () => {
  it("is the owner's call, is final, and leaves the funds where they are", async () => {
    const id = await awaitingFunding(acme, alpha);
    await authorizeFunding(acme.owner, id, funding("45"));
    const masterBefore = await masterBalance(acme.org, "goat");

    await expect(cancelEngagement(acmeAdmin, id)).rejects.toMatchObject({ code: "forbidden" });
    const cancelled = await cancelEngagement(acme.owner, id);
    expect(cancelled.state).toBe("CANCELLED");
    expect(cancelled.closedAt).toBeInstanceOf(Date);

    const detail = await getEngagementDetail(acme.owner, id);
    expect(detail.mandate?.status).toBe("revoked");
    expect(detail.agent?.status).toBe("revoked");
    // Unused funds are not moved anywhere without a person's authorization.
    expect(detail.wallet).toMatchObject({ status: "closing", balanceUnits: 4500n });
    expect(await masterBalance(acme.org, "goat")).toBe(masterBefore);

    await expect(authorizeFunding(acme.owner, id, funding("5"))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(cancelEngagement(acme.owner, id)).rejects.toMatchObject({ code: "conflict" });
    await expect(
      db.update(schema.engagements).set({ state: "ACTIVE" }).where(eq(schema.engagements.id, id)),
    ).rejects.toThrow();
    expect(await state(id)).toBe("CANCELLED");
  });

  it("closes an unfunded wallet, and works before a wallet exists", async () => {
    const unfunded = await awaitingFunding(acme, alpha);
    await cancelEngagement(acme.owner, unfunded);
    expect((await walletOf(unfunded)).status).toBe("closed");

    const early = await drafted(acme, alpha);
    expect((await cancelEngagement(acme.owner, early)).state).toBe("CANCELLED");
    expect(await walletOf(early)).toBeUndefined();
  });

  it("expires at its deadline and then refuses everything", async () => {
    const id = await awaitingFunding(acme, alpha);
    await authorizeFunding(acme.owner, id, funding("12"));
    await db
      .update(schema.engagements)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.engagements.id, id));

    await expect(authorizeFunding(acme.owner, id, funding("5"))).rejects.toMatchObject({
      code: "conflict",
    });
    // The refusal is not rolled back: the engagement is now recorded as expired.
    expect(await state(id)).toBe("EXPIRED");
    const detail = await getEngagementDetail(acme.owner, id);
    expect(detail.agent?.status).toBe("revoked");
    expect(detail.wallet).toMatchObject({ status: "closing", balanceUnits: 1200n });
    expect(detail.events.at(-1)).toMatchObject({ toState: "EXPIRED", actorName: null });
    expect(await checkAgentCommunication(id, alpha.id)).toMatchObject({ allowed: false });
  });

  it("is noticed when engagements are listed, without anyone acting on it", async () => {
    const buyer = await createBuyer("lister");
    const id = await drafted(buyer, alpha);
    await authorizeEngagement(buyer.owner, id, { confirmed: true });
    await db
      .update(schema.engagements)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.engagements.id, id));
    const list = await listEngagements(buyer.owner, buyer.org);
    expect(list.find((e) => e.id === id)?.state).toBe("EXPIRED");
  });

  it("keeps a project that has engagements", async () => {
    const buyer = await createBuyer("keeper");
    await drafted(buyer, alpha);
    await expect(deleteProject(buyer.owner, buyer.projectId)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("when the wallet provider fails", () => {
  afterEach(() => setWalletProvider("goat", undefined));

  const failing = (overrides: Partial<WalletProvider>): WalletProvider => {
    const base = new SimulatedWalletProvider("goat");
    return Object.assign(Object.create(Object.getPrototypeOf(base)), base, overrides);
  };

  it("marks the engagement failed if the wallet cannot be provisioned", async () => {
    const id = await drafted(acme, beta);
    await authorizeEngagement(acme.owner, id, { confirmed: true });
    setWalletProvider(
      "goat",
      failing({
        provisionEngagementWallet: async () => {
          throw new Error("provider unavailable");
        },
      }),
    );
    const result = await provisionEngagementWallet(acme.owner, id);
    expect(result.state).toBe("FAILED");
    expect(await walletOf(id)).toBeUndefined();
    expect(await checkAgentCommunication(id, beta.id)).toMatchObject({ allowed: false });
  });

  it("records a failed funding and moves nothing", async () => {
    await depositSimulatedFunds(acme.owner, acme.org, { rail: "goat", amount: "100" });
    const id = await awaitingFunding(acme, beta);
    const before = await masterBalance(acme.org, "goat");
    setWalletProvider(
      "goat",
      failing({ executeFunding: async () => ({ status: "failed", reason: "Transfer rejected." }) }),
    );
    const key = randomUUID();
    const outcome = await authorizeFunding(acme.owner, id, funding("30", key));

    expect(outcome.funding).toMatchObject({ status: "failed", failureReason: "Transfer rejected." });
    expect(outcome.engagement.state).toBe("AWAITING_FUNDING");
    expect(await masterBalance(acme.org, "goat")).toBe(before);
    expect((await walletOf(id)).balanceUnits).toBe(0n);
    expect(await checkAgentCommunication(id, beta.id)).toMatchObject({ allowed: false });

    // Submitting the same authorization again does not retry the transfer.
    setWalletProvider("goat", undefined);
    const again = await authorizeFunding(acme.owner, id, funding("30", key));
    expect(again.replayed).toBe(true);
    expect(again.funding.status).toBe("failed");
    expect((await walletOf(id)).balanceUnits).toBe(0n);
  });
});

describe("simulated master funds", () => {
  it("can only be added by the owner of a buying organization", async () => {
    await expect(
      depositSimulatedFunds(acmeAdmin, acme.org, { rail: "goat", amount: "10" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      depositSimulatedFunds(globex.owner, acme.org, { rail: "goat", amount: "10" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      depositSimulatedFunds(alpha.owner, alpha.org, { rail: "goat", amount: "10" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    for (const amount of ["0", "-5", "abc", "1.234", "99999999999"]) {
      await expect(
        depositSimulatedFunds(acme.owner, acme.org, { rail: "goat", amount }),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(
      depositSimulatedFunds(acme.owner, acme.org, { rail: "paypal", amount: "10" }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("is recorded in the ledger and flagged as simulated", async () => {
    const buyer = await createBuyer("depositor");
    const account = await depositSimulatedFunds(buyer.owner, buyer.org, { amount: "75.5" });
    expect(account).toMatchObject({ balanceUnits: 7550n, isSimulated: true, rail: "goat" });
    const overview = await getWalletOverview(buyer.owner, buyer.org);
    expect(overview.ledger[0]).toMatchObject({
      kind: "simulated_deposit",
      account: "master",
      deltaUnits: 7550n,
      balanceAfterUnits: 7550n,
    });
    // One account, on the settlement network. No other rail is shown.
    expect(overview.rails).toHaveLength(1);
    expect(overview.rails[0]).toMatchObject({ rail: "goat", retired: false, unallocatedUnits: 7550n });
  });
});

describe("unauthenticated callers", () => {
  const calls: Array<[string, () => Promise<unknown>]> = [
    ["createEngagement", () => createEngagement(null, MISSING_ID, {})],
    ["saveMandateDraft", () => saveMandateDraft(null, MISSING_ID, mandate({ offeringIds: [MISSING_ID] } as Seller))],
    ["authorizeEngagement", () => authorizeEngagement(null, MISSING_ID, { confirmed: true })],
    ["provisionEngagementWallet", () => provisionEngagementWallet(null, MISSING_ID)],
    ["authorizeFunding", () => authorizeFunding(null, MISSING_ID, funding("10"))],
    ["cancelEngagement", () => cancelEngagement(null, MISSING_ID)],
    ["listEngagements", () => listEngagements(null, MISSING_ID)],
    ["getEngagementDetail", () => getEngagementDetail(null, MISSING_ID)],
    ["getWalletOverview", () => getWalletOverview(null, MISSING_ID)],
    ["depositSimulatedFunds", () => depositSimulatedFunds(null, MISSING_ID, { rail: "goat", amount: "1" })],
  ];

  it.each(calls)("%s is rejected", async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ code: "unauthenticated" });
  });
});
