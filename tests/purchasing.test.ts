import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { completeOnboarding } from "@/server/accounts";
import {
  approveBudgetIncrease,
  listApprovals,
  modifyProposedWork,
  rejectApproval,
} from "@/server/approvals";
import type { Actor } from "@/server/authz";
import { getBudgetStatus } from "@/server/budget";
import { getEngagementActivity } from "@/server/engagement-activity";
import {
  authorizeEngagement,
  authorizeFunding,
  cancelEngagement,
  createEngagement,
  getEngagementDetail,
  provisionEngagementWallet,
  saveMandateDraft,
} from "@/server/engagements";
import { DemoPaymentProvider } from "@/server/payments/demo";
import type { PaymentProvider } from "@/server/payments/provider";
import { setPaymentProvider, simulatedRecipient } from "@/server/payments/registry";
import { executePurchase, reconcilePurchase } from "@/server/policy";
import { createProject } from "@/server/projects";
import { createOffering, saveSellerEndpoint, updateSellerListing } from "@/server/sellers";
import { depositSimulatedFunds } from "@/server/wallets";
import {
  addMember,
  createUser,
  platformActivate,
  useTestDatabase,
  validEndpoint,
  validListing,
  validProject,
} from "./support/db";

let db: Db;
let close: () => Promise<void>;

type Seller = {
  owner: Actor;
  org: string;
  slug: string;
  id: string;
  /** Offering ids by price in dollars: 4, 8, 15, 25. */
  offering: Record<4 | 8 | 15 | 25, string>;
};
type Buyer = { owner: Actor; org: string; projectId: string };

let acme: Buyer;
let acmeAdmin: Actor;
let globex: Buyer;
let alpha: Seller;
let beta: Seller;

const SERVICES = [
  { price: 4, name: "API contract check", capability: "api_testing" },
  { price: 8, name: "Dependency check", capability: "dependency_checks" },
  { price: 15, name: "Unit test run", capability: "unit_testing" },
  { price: 25, name: "Regression suite", capability: "regression_testing" },
] as const;

async function createSeller(label: string): Promise<Seller> {
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
    capabilities: ["unit_testing", "regression_testing", "api_testing", "dependency_checks"],
    intendedRails: ["goat", "qatom"],
  });
  await saveSellerEndpoint(owner, org, validEndpoint);
  const offering = {} as Seller["offering"];
  for (const service of SERVICES) {
    const created = await createOffering(owner, org, {
      name: service.name,
      description: "",
      capability: service.capability,
      billingUnit: "per_run",
      priceMinor: service.price * 100,
    });
    offering[service.price] = created.id;
  }
  await platformActivate(db, ws.sellerProfile!.slug);
  return { owner, org, slug: ws.sellerProfile!.slug, id: ws.sellerProfile!.id, offering };
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
  await depositSimulatedFunds(owner, ws.organization.id, { rail: "goat", amount: "100000" });
  return { owner, org: ws.organization.id, projectId: project.id };
}

type Setup = { total?: string; perPurchase?: string; fund?: string | null; offeringIds?: string[] };

/** An engagement taken as far as its funding allows. `fund: null` leaves it awaiting funding. */
async function engage(buyer: Buyer, seller: Seller, setup: Setup = {}): Promise<string> {
  const engagement = await createEngagement(buyer.owner, buyer.org, {
    sellerSlug: seller.slug,
    projectId: buyer.projectId,
  });
  await saveMandateDraft(buyer.owner, engagement.id, {
    rail: "goat",
    totalBudget: setup.total ?? "100",
    perTransactionLimit: setup.perPurchase ?? "25",
    offeringIds: setup.offeringIds ?? Object.values(seller.offering),
    scope: "Run the unit and regression suites against the main branch.",
    expiresInDays: 30,
  });
  await authorizeEngagement(buyer.owner, engagement.id, { confirmed: true });
  await provisionEngagementWallet(buyer.owner, engagement.id);
  if (setup.fund !== null) {
    await authorizeFunding(buyer.owner, engagement.id, {
      amount: setup.fund ?? "100",
      idempotencyKey: randomUUID(),
      confirmed: true,
    });
  }
  return engagement.id;
}

/** A purchase request carrying exactly the terms an honest seller would quote. */
function request(engagementId: string, seller: Seller, price: 4 | 8 | 15 | 25, overrides: Record<string, unknown> = {}) {
  const { quote: quoteOverrides, ...rest } = overrides as { quote?: Record<string, unknown> };
  return {
    engagementId,
    offeringId: seller.offering[price],
    idempotencyKey: randomUUID(),
    quote: {
      sellerProfileId: seller.id,
      asset: "SIM-USD",
      amountUnits: BigInt(price * 100),
      recipient: simulatedRecipient("goat", seller.id),
      ...quoteOverrides,
    },
    explanation: "Next in the test plan.",
    ...rest,
  };
}

async function buy(engagementId: string, seller: Seller, price: 4 | 8 | 15 | 25) {
  return executePurchase(request(engagementId, seller, price));
}

async function stateOf(id: string) {
  const [row] = await db.select().from(schema.engagements).where(eq(schema.engagements.id, id));
  return row.state;
}

async function walletBalance(id: string) {
  const [row] = await db
    .select()
    .from(schema.engagementWallets)
    .where(eq(schema.engagementWallets.engagementId, id));
  return row.balanceUnits;
}

async function mandateOf(id: string) {
  const [row] = await db
    .select()
    .from(schema.spendingMandates)
    .where(eq(schema.spendingMandates.engagementId, id));
  return row;
}

async function pendingApproval(id: string) {
  const [row] = await db
    .select()
    .from(schema.approvalRequests)
    .where(and(eq(schema.approvalRequests.engagementId, id), eq(schema.approvalRequests.status, "pending")));
  return row;
}

async function paymentsFor(id: string) {
  return db.select().from(schema.paymentTransactions).where(eq(schema.paymentTransactions.engagementId, id));
}

/** A provider that behaves like the demo provider except where overridden. */
function providerWith(overrides: Partial<PaymentProvider>): PaymentProvider & { calls: number } {
  const base = new DemoPaymentProvider("goat");
  const wrapped = {
    rail: base.rail,
    name: base.name,
    simulated: base.simulated,
    calls: 0,
    validatePaymentRequirement: base.validatePaymentRequirement.bind(base),
    getPaymentStatus: base.getPaymentStatus.bind(base),
    verifyPayment: base.verifyPayment.bind(base),
    initiatePayment: base.initiatePayment.bind(base),
    ...overrides,
  };
  const initiate = wrapped.initiatePayment;
  wrapped.initiatePayment = async (payment) => {
    wrapped.calls += 1;
    return initiate(payment);
  };
  return wrapped;
}

beforeAll(async () => {
  ({ db, close } = await useTestDatabase());
  alpha = await createSeller("alpha");
  beta = await createSeller("beta");
  acme = await createBuyer("acme");
  globex = await createBuyer("globex");
  acmeAdmin = await createUser(db, "acme-admin");
  await addMember(db, acme.org, acmeAdmin.userId, "admin");
});
afterAll(async () => close());
afterEach(() => setPaymentProvider("goat", undefined));

describe("a purchase within the mandate", () => {
  it("is paid, verified, debited from the engagement wallet and recorded", async () => {
    const id = await engage(acme, alpha);
    const outcome = await buy(id, alpha, 25);

    expect(outcome.status).toBe("paid");
    expect(outcome.purchase).toMatchObject({ status: "paid", amountUnits: 2500n, isSimulated: true });
    expect(await walletBalance(id)).toBe(7500n);

    const [payment] = await paymentsFor(id);
    expect(payment).toMatchObject({
      amountUnits: 2500n,
      asset: "SIM-USD",
      rail: "goat",
      sellerProfileId: alpha.id,
      recipient: simulatedRecipient("goat", alpha.id),
      isSimulated: true,
    });
    expect(payment.providerRef).toContain("demo-payment:goat:");
    expect(payment.verifiedAt).toBeInstanceOf(Date);

    const budget = await getBudgetStatus(db, id);
    expect(budget).toMatchObject({
      spentUnits: 2500n,
      reservedUnits: 0n,
      remainingUnits: 7500n,
      walletBalanceUnits: 7500n,
    });
    const ledger = await db
      .select()
      .from(schema.walletLedgerEntries)
      .where(eq(schema.walletLedgerEntries.kind, "payment_debit"));
    expect(ledger.some((l) => l.deltaUnits === -2500n && l.balanceAfterUnits === 7500n)).toBe(true);
    expect(await stateOf(id)).toBe("ACTIVE");
  });

  it("never touches the master account or another engagement's wallet", async () => {
    const buyer = await createBuyer("isolated");
    const first = await engage(buyer, alpha);
    const second = await engage(buyer, alpha);
    const [master] = await db
      .select()
      .from(schema.masterWalletAccounts)
      .where(eq(schema.masterWalletAccounts.organizationId, buyer.org));

    await buy(first, alpha, 25);
    await buy(first, alpha, 15);

    expect(await walletBalance(first)).toBe(6000n);
    expect(await walletBalance(second)).toBe(10000n);
    const [masterAfter] = await db
      .select()
      .from(schema.masterWalletAccounts)
      .where(eq(schema.masterWalletAccounts.id, master.id));
    expect(masterAfter.balanceUnits).toBe(master.balanceUnits);
    expect(await paymentsFor(second)).toEqual([]);
    expect((await getBudgetStatus(db, second))?.spentUnits).toBe(0n);
  });
});

describe("the budget demonstration: $100 authorized, $85 used, $25 proposed", () => {
  let id: string;

  it("lets the agent spend $85", async () => {
    id = await engage(acme, alpha, { total: "100", fund: "100" });
    for (const price of [25, 25, 15, 8, 8, 4] as const) {
      expect((await buy(id, alpha, price)).status).toBe("paid");
    }
    expect(await getBudgetStatus(db, id)).toMatchObject({ spentUnits: 8500n, remainingUnits: 1500n });
  });

  it("blocks the $25 purchase, because only $15 of the budget remains", async () => {
    const outcome = await buy(id, alpha, 25);
    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "budget_exceeded",
      approvalRequested: true,
    });
    expect(await walletBalance(id)).toBe(1500n);
    expect((await paymentsFor(id)).length).toBe(6);
    expect((await getBudgetStatus(db, id))?.spentUnits).toBe(8500n);
  });

  it("pauses the engagement and asks the buyer, with the facts", async () => {
    expect(await stateOf(id)).toBe("PAUSED_FOR_APPROVAL");
    const approval = await pendingApproval(id);
    expect(approval).toMatchObject({
      kind: "budget_increase",
      offeringName: "Regression suite",
      proposedAmountUnits: 2500n,
      totalAuthorizedUnits: 10000n,
      spentUnits: 8500n,
      reservedUnits: 0n,
      shortfallUnits: 1000n,
      explanation: "Next in the test plan.",
    });
    const [listed] = await listApprovals(acme.owner, acme.org);
    expect(listed).toMatchObject({ id: approval.id, sellerName: "alpha agents", status: "pending" });
  });

  it("starts no further paid work while paused, however small", async () => {
    const outcome = await buy(id, alpha, 4);
    expect(outcome).toMatchObject({ status: "blocked", reason: "engagement_not_active" });
    expect((await paymentsFor(id)).length).toBe(6);
  });

  it("raises the budget to $500 only on the owner's confirmed approval", async () => {
    const approval = await pendingApproval(id);
    await expect(
      approveBudgetIncrease(acmeAdmin, approval.id, { newTotal: "500", confirmed: true }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      approveBudgetIncrease(acme.owner, approval.id, { newTotal: "500", confirmed: false }),
    ).rejects.toMatchObject({ code: "invalid" });
    for (const newTotal of ["100", "50", "105", "abc", "-1"]) {
      await expect(
        approveBudgetIncrease(acme.owner, approval.id, { newTotal, confirmed: true }),
        newTotal,
      ).rejects.toMatchObject({ code: "invalid" });
    }
    expect((await mandateOf(id)).totalAuthorizedUnits).toBe(10000n);

    const before = await mandateOf(id);
    const detailBefore = await getEngagementDetail(acme.owner, id);
    const decided = await approveBudgetIncrease(acme.owner, approval.id, { newTotal: "500", confirmed: true });
    expect(decided).toMatchObject({ status: "approved", approvedTotalUnits: 50000n });

    const after = await mandateOf(id);
    expect(after.totalAuthorizedUnits).toBe(50000n);
    expect(after.version).toBe(before.version + 1);
    expect(await stateOf(id)).toBe("ACTIVE");

    // The approval changed the budget and nothing else.
    expect(after.perTransactionLimitUnits).toBe(before.perTransactionLimitUnits);
    expect(after.scope).toBe(before.scope);
    expect(after.expiresAt).toEqual(before.expiresAt);
    expect(after.sellerProfileId).toBe(before.sellerProfileId);
    expect(after.authorizedRecipient).toBe(before.authorizedRecipient);
    const detailAfter = await getEngagementDetail(acme.owner, id);
    expect(detailAfter.mandate?.permittedOfferingIds.sort()).toEqual(
      detailBefore.mandate?.permittedOfferingIds.sort(),
    );
  });

  it("moves no funds when the budget is raised", async () => {
    // $400 more authority, not one unit more money: the wallet still holds $15.
    expect(await walletBalance(id)).toBe(1500n);
    const detail = await getEngagementDetail(acme.owner, id);
    expect(detail.fundings).toHaveLength(1);
    expect(await getBudgetStatus(db, id)).toMatchObject({
      totalUnits: 50000n,
      remainingUnits: 41500n,
      walletBalanceUnits: 1500n,
    });
  });

  it("then blocks the same purchase for lack of funds, and asks for funding separately", async () => {
    const outcome = await buy(id, alpha, 25);
    expect(outcome).toMatchObject({
      status: "blocked",
      reason: "insufficient_wallet_funds",
      approvalRequested: true,
    });
    expect(await stateOf(id)).toBe("PAUSED_FOR_APPROVAL");
    expect(await pendingApproval(id)).toMatchObject({
      kind: "additional_funding",
      proposedAmountUnits: 2500n,
      walletBalanceUnits: 1500n,
      shortfallUnits: 1000n,
    });
    // A funding request cannot be answered by approving a budget.
    await expect(
      approveBudgetIncrease(acme.owner, (await pendingApproval(id)).id, { newTotal: "900", confirmed: true }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("resumes once the owner separately authorizes more funding", async () => {
    // Too little to cover the purchase: the request stays open.
    await authorizeFunding(acme.owner, id, { amount: "5", idempotencyKey: randomUUID(), confirmed: true });
    expect(await stateOf(id)).toBe("PAUSED_FOR_APPROVAL");

    await authorizeFunding(acme.owner, id, { amount: "100", idempotencyKey: randomUUID(), confirmed: true });
    expect(await stateOf(id)).toBe("ACTIVE");
    expect(await pendingApproval(id)).toBeUndefined();
    expect(await walletBalance(id)).toBe(12000n);

    expect((await buy(id, alpha, 25)).status).toBe("paid");
    expect(await getBudgetStatus(db, id)).toMatchObject({ spentUnits: 11000n, walletBalanceUnits: 9500n });
  });
});

describe("what the policy engine refuses", () => {
  it("a purchase above the per-purchase limit, without offering an approval", async () => {
    const id = await engage(acme, alpha, { perPurchase: "20" });
    const outcome = await buy(id, alpha, 25);
    expect(outcome).toMatchObject({ status: "blocked", reason: "per_purchase_limit", approvalRequested: false });
    expect(await stateOf(id)).toBe("ACTIVE");
    expect((await buy(id, alpha, 15)).status).toBe("paid");
  });

  it("a service the mandate does not permit", async () => {
    const id = await engage(acme, alpha, { offeringIds: [alpha.offering[4], alpha.offering[8]] });
    expect(await buy(id, alpha, 25)).toMatchObject({ status: "blocked", reason: "service_not_permitted" });
    expect((await buy(id, alpha, 4)).status).toBe("paid");
  });

  it("a service from any seller other than the one selected", async () => {
    const id = await engage(acme, alpha);
    // Another seller's service, quoted honestly by that other seller.
    expect(await buy(id, beta, 4)).toMatchObject({ status: "blocked", reason: "wrong_seller" });
    // The right service, but the quote claims to come from another seller.
    expect(
      await executePurchase(request(id, alpha, 4, { quote: { sellerProfileId: beta.id } })),
    ).toMatchObject({ status: "blocked", reason: "wrong_seller" });
    expect(await paymentsFor(id)).toEqual([]);
  });

  it("a seller asking to be paid at an account the mandate does not authorize", async () => {
    const id = await engage(acme, alpha);
    for (const recipient of [
      simulatedRecipient("goat", beta.id),
      simulatedRecipient("qatom", alpha.id),
      "0x000000000000000000000000000000000000dEaD",
      "",
    ]) {
      expect(
        await executePurchase(request(id, alpha, 4, { quote: { recipient } })),
        recipient,
      ).toMatchObject({ status: "blocked", reason: "recipient_not_authorized" });
    }
    expect(await paymentsFor(id)).toEqual([]);
    expect(await walletBalance(id)).toBe(10000n);
    expect((await getBudgetStatus(db, id))?.reservedUnits).toBe(0n);
  });

  it("a quote that differs from the listed price or the mandate's asset", async () => {
    const id = await engage(acme, alpha);
    for (const amountUnits of [401n, 399n, 0n, -400n, 40000n]) {
      expect(
        await executePurchase(request(id, alpha, 4, { quote: { amountUnits } })),
        String(amountUnits),
      ).toMatchObject({ status: "blocked", reason: "amount_mismatch" });
    }
    expect(await executePurchase(request(id, alpha, 4, { quote: { asset: "USD-TDN" } }))).toMatchObject({
      status: "blocked",
      reason: "asset_mismatch",
    });
    expect(await paymentsFor(id)).toEqual([]);
  });

  it("anything at all unless the engagement is active", async () => {
    const waiting = await engage(acme, alpha, { fund: null });
    expect(await buy(waiting, alpha, 4)).toMatchObject({ status: "blocked", reason: "engagement_not_active" });

    const cancelled = await engage(acme, alpha);
    await cancelEngagement(acme.owner, cancelled);
    expect(await buy(cancelled, alpha, 4)).toMatchObject({ status: "blocked", reason: "engagement_not_active" });

    const expired = await engage(acme, alpha);
    await db
      .update(schema.engagements)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.engagements.id, expired));
    expect(await buy(expired, alpha, 4)).toMatchObject({ status: "blocked", reason: "engagement_not_active" });
    expect(await stateOf(expired)).toBe("EXPIRED");

    const suspended = await engage(acme, alpha);
    await db
      .update(schema.purchasingAgents)
      .set({ status: "suspended" })
      .where(eq(schema.purchasingAgents.engagementId, suspended));
    expect(await buy(suspended, alpha, 4)).toMatchObject({ status: "blocked", reason: "engagement_not_active" });

    for (const id of [waiting, cancelled, expired, suspended]) {
      expect(await paymentsFor(id), id).toEqual([]);
    }
  });

  it("keeps a record of every blocked attempt", async () => {
    const id = await engage(acme, alpha, { perPurchase: "20" });
    await buy(id, alpha, 25);
    const activity = await getEngagementActivity(acme.owner, id);
    expect(activity.purchases[0]).toMatchObject({ status: "blocked", offeringName: "Regression suite" });
    expect(activity.messages.some((m) => m.kind === "purchase_blocked")).toBe(true);
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "purchase.blocked"));
    expect(audit.some((a) => (a.metadata as { engagementId?: string }).engagementId === id)).toBe(true);
  });
});

describe("duplicate and simultaneous requests", () => {
  it("charges once when the same purchase is requested again", async () => {
    const id = await engage(acme, alpha);
    const once = request(id, alpha, 25);
    const first = await executePurchase(once);
    const second = await executePurchase(once);
    const [third, fourth] = await Promise.all([executePurchase(once), executePurchase(once)]);

    expect(first).toMatchObject({ status: "paid", replayed: false });
    for (const repeat of [second, third, fourth]) {
      expect(repeat).toMatchObject({ status: "paid", replayed: true });
      expect(repeat.purchase?.id).toBe(first.purchase?.id);
    }
    expect(await walletBalance(id)).toBe(7500n);
    expect(await paymentsFor(id)).toHaveLength(1);
  });

  it("does not accept one engagement's purchase key for another", async () => {
    const first = await engage(acme, alpha);
    const second = await engage(acme, alpha);
    const key = randomUUID();
    await executePurchase(request(first, alpha, 4, { idempotencyKey: key }));
    expect(await executePurchase(request(second, alpha, 4, { idempotencyKey: key }))).toMatchObject({
      status: "blocked",
    });
    expect(await paymentsFor(second)).toEqual([]);
  });

  it("cannot exceed the budget with purchases made at the same moment", async () => {
    const id = await engage(acme, alpha, { total: "100", fund: "500" });
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => buy(id, alpha, 25)));

    expect(outcomes.filter((o) => o.status === "paid")).toHaveLength(4);
    expect(outcomes.filter((o) => o.status === "blocked")).toHaveLength(4);
    const budget = await getBudgetStatus(db, id);
    expect(budget).toMatchObject({ spentUnits: 10000n, reservedUnits: 0n, remainingUnits: 0n });
    expect(await walletBalance(id)).toBe(40000n);
    expect(await paymentsFor(id)).toHaveLength(4);
  });

  it("cannot overdraw the wallet with purchases made at the same moment", async () => {
    const id = await engage(acme, alpha, { total: "500", fund: "60" });
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => buy(id, alpha, 25)));
    expect(outcomes.filter((o) => o.status === "paid")).toHaveLength(2);
    expect(await walletBalance(id)).toBe(1000n);
    expect((await getBudgetStatus(db, id))?.spentUnits).toBe(5000n);
  });
});

describe("limits enforced by the database", () => {
  async function reservationParts(id: string) {
    const mandate = await mandateOf(id);
    const [purchase] = await db
      .insert(schema.purchases)
      .values({
        engagementId: id,
        serviceOfferingId: alpha.offering[25],
        offeringName: "Direct insert",
        asset: "SIM-USD",
        amountUnits: 100n,
        recipient: "x",
        idempotencyKey: randomUUID(),
        status: "reserved",
      })
      .returning();
    return { mandate, purchase };
  }

  it("refuses a reservation beyond the budget or the per-purchase limit", async () => {
    const id = await engage(acme, alpha, { total: "100", perPurchase: "25" });
    await buy(id, alpha, 25);
    await buy(id, alpha, 25);
    await buy(id, alpha, 25);

    const tooMuch = await reservationParts(id);
    await expect(
      db.insert(schema.spendingReservations).values({
        purchaseId: tooMuch.purchase.id,
        engagementId: id,
        mandateId: tooMuch.mandate.id,
        amountUnits: 2501n,
      }),
    ).rejects.toThrow();

    const overLimit = await reservationParts(id);
    await expect(
      db.insert(schema.spendingReservations).values({
        purchaseId: overLimit.purchase.id,
        engagementId: id,
        mandateId: overLimit.mandate.id,
        amountUnits: 2600n,
      }),
    ).rejects.toThrow();

    // Exactly what remains is still accepted.
    const exact = await reservationParts(id);
    await db.insert(schema.spendingReservations).values({
      purchaseId: exact.purchase.id,
      engagementId: id,
      mandateId: exact.mandate.id,
      amountUnits: 2500n,
    });
    const one = await reservationParts(id);
    await expect(
      db.insert(schema.spendingReservations).values({
        purchaseId: one.purchase.id,
        engagementId: id,
        mandateId: one.mandate.id,
        amountUnits: 1n,
      }),
    ).rejects.toThrow();
  });

  it("refuses a reservation against a mandate that is not authorized, or another engagement's", async () => {
    const draft = await createEngagement(acme.owner, acme.org, {
      sellerSlug: alpha.slug,
      projectId: acme.projectId,
    });
    await saveMandateDraft(acme.owner, draft.id, {
      rail: "goat",
      totalBudget: "100",
      perTransactionLimit: "25",
      offeringIds: Object.values(alpha.offering),
      scope: "Run the unit suite on main.",
      expiresInDays: 30,
    });
    const parts = await reservationParts(draft.id);
    await expect(
      db.insert(schema.spendingReservations).values({
        purchaseId: parts.purchase.id,
        engagementId: draft.id,
        mandateId: parts.mandate.id,
        amountUnits: 100n,
      }),
    ).rejects.toThrow();

    const a = await engage(acme, alpha);
    const b = await engage(acme, alpha);
    const partsA = await reservationParts(a);
    await expect(
      db.insert(schema.spendingReservations).values({
        purchaseId: partsA.purchase.id,
        engagementId: a,
        mandateId: (await mandateOf(b)).id,
        amountUnits: 100n,
      }),
    ).rejects.toThrow();
  });

  it("does not let a reservation or a confirmed payment be rewritten", async () => {
    const id = await engage(acme, alpha);
    await buy(id, alpha, 25);
    const [reservation] = await db
      .select()
      .from(schema.spendingReservations)
      .where(eq(schema.spendingReservations.engagementId, id));
    await expect(
      db
        .update(schema.spendingReservations)
        .set({ amountUnits: 1n })
        .where(eq(schema.spendingReservations.id, reservation.id)),
    ).rejects.toThrow();
    await expect(
      db
        .update(schema.spendingReservations)
        .set({ status: "released" })
        .where(eq(schema.spendingReservations.id, reservation.id)),
    ).rejects.toThrow();
    const [payment] = await paymentsFor(id);
    await expect(
      db
        .update(schema.paymentTransactions)
        .set({ amountUnits: 1n })
        .where(eq(schema.paymentTransactions.id, payment.id)),
    ).rejects.toThrow();
  });

  it("does not let a payment be drawn on another engagement's wallet", async () => {
    const a = await engage(acme, alpha);
    const b = await engage(acme, alpha);
    const [walletB] = await db
      .select()
      .from(schema.engagementWallets)
      .where(eq(schema.engagementWallets.engagementId, b));
    const parts = await reservationParts(a);
    const [reservation] = await db
      .insert(schema.spendingReservations)
      .values({ purchaseId: parts.purchase.id, engagementId: a, mandateId: parts.mandate.id, amountUnits: 100n })
      .returning();
    await expect(
      db.insert(schema.paymentAttempts).values({
        purchaseId: parts.purchase.id,
        reservationId: reservation.id,
        engagementId: a,
        engagementWalletId: walletB.id,
        rail: "goat",
        asset: "SIM-USD",
        amountUnits: 100n,
        recipient: "x",
        provider: "demo",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow();
  });
});

describe("when a payment does not clearly succeed", () => {
  it("releases the reservation on a definite failure, and does not try again", async () => {
    const id = await engage(acme, alpha);
    const failing = providerWith({
      initiatePayment: async () => ({ status: "failed", reason: "Declined by the rail." }),
    });
    setPaymentProvider("goat", failing);
    const once = request(id, alpha, 25);
    const outcome = await executePurchase(once);

    expect(outcome).toMatchObject({ status: "payment_failed" });
    expect(await walletBalance(id)).toBe(10000n);
    expect(await paymentsFor(id)).toEqual([]);
    expect(await getBudgetStatus(db, id)).toMatchObject({ spentUnits: 0n, reservedUnits: 0n, remainingUnits: 10000n });

    // The same request again returns the recorded failure without calling the provider.
    const again = await executePurchase(once);
    expect(again).toMatchObject({ status: "payment_failed", replayed: true });
    expect(failing.calls).toBe(1);
  });

  it("keeps the capacity reserved when the outcome is unknown, and never retries", async () => {
    const id = await engage(acme, alpha, { total: "40" });
    const silent = providerWith({
      initiatePayment: async () => {
        throw new Error("timeout");
      },
    });
    setPaymentProvider("goat", silent);
    const once = request(id, alpha, 25);
    const outcome = await executePurchase(once);

    expect(outcome).toMatchObject({ status: "needs_reconciliation" });
    expect(await paymentsFor(id)).toEqual([]);
    expect(await walletBalance(id)).toBe(10000n);
    // The $25 stays reserved, so it cannot be spent a second time.
    expect(await getBudgetStatus(db, id)).toMatchObject({ reservedUnits: 2500n, remainingUnits: 1500n });

    const again = await executePurchase(once);
    expect(again).toMatchObject({ status: "needs_reconciliation", replayed: true });
    expect(silent.calls).toBe(1);

    // Until that payment is settled, nothing else is bought.
    setPaymentProvider("goat", undefined);
    expect(await buy(id, alpha, 25)).toMatchObject({ status: "blocked", reason: "payment_unresolved" });
    expect(await getBudgetStatus(db, id)).toMatchObject({ spentUnits: 0n, reservedUnits: 2500n });
  });

  it("does not record success for a payment it cannot verify", async () => {
    const id = await engage(acme, alpha);
    setPaymentProvider("goat", providerWith({ verifyPayment: async () => false }));
    const outcome = await buy(id, alpha, 25);
    expect(outcome).toMatchObject({ status: "needs_reconciliation" });
    expect(await paymentsFor(id)).toEqual([]);
    expect(await walletBalance(id)).toBe(10000n);
  });

  it("reconciles an unknown payment from the provider's record, once", async () => {
    const id = await engage(acme, alpha);
    const base = new DemoPaymentProvider("goat");
    // The payment goes through at the provider, but the answer is lost on the way back.
    const lossy = providerWith({
      initiatePayment: async (payment) => {
        await base.initiatePayment(payment);
        throw new Error("connection reset");
      },
      getPaymentStatus: base.getPaymentStatus.bind(base),
      verifyPayment: base.verifyPayment.bind(base),
    });
    setPaymentProvider("goat", lossy);
    const outcome = await buy(id, alpha, 25);
    expect(outcome.status).toBe("needs_reconciliation");
    const purchaseId = outcome.purchase!.id;

    await expect(reconcilePurchase(globex.owner, purchaseId)).rejects.toMatchObject({ code: "not_found" });
    await expect(reconcilePurchase(alpha.owner, purchaseId)).rejects.toMatchObject({ code: "not_found" });

    const reconciled = await reconcilePurchase(acme.owner, purchaseId);
    expect(reconciled.status).toBe("paid");
    expect(await walletBalance(id)).toBe(7500n);
    expect(await paymentsFor(id)).toHaveLength(1);
    expect(lossy.calls).toBe(1);
    await expect(reconcilePurchase(acme.owner, purchaseId)).rejects.toMatchObject({ code: "conflict" });
    expect(await walletBalance(id)).toBe(7500n);
  });

  it("releases the reservation when reconciliation finds the payment failed", async () => {
    const id = await engage(acme, alpha);
    setPaymentProvider(
      "goat",
      providerWith({
        initiatePayment: async () => {
          throw new Error("timeout");
        },
        getPaymentStatus: async () => ({ status: "failed", reason: "Never settled." }),
      }),
    );
    const outcome = await buy(id, alpha, 25);
    const reconciled = await reconcilePurchase(acme.owner, outcome.purchase!.id);
    expect(reconciled.status).toBe("payment_failed");
    expect(await getBudgetStatus(db, id)).toMatchObject({ reservedUnits: 0n, remainingUnits: 10000n });
    expect(await walletBalance(id)).toBe(10000n);
  });
});

describe("approval decisions", () => {
  async function blockedOnBudget() {
    const id = await engage(acme, alpha, { total: "30", fund: "100" });
    await buy(id, alpha, 25);
    await buy(id, alpha, 15);
    return { id, approval: await pendingApproval(id) };
  }

  it("belong to the buying organization's owner alone", async () => {
    const { id, approval } = await blockedOnBudget();
    for (const outsider of [globex.owner, alpha.owner]) {
      await expect(
        approveBudgetIncrease(outsider, approval.id, { newTotal: "500", confirmed: true }),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(rejectApproval(outsider, approval.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(
        modifyProposedWork(outsider, approval.id, { replacementOfferingId: alpha.offering[4] }),
      ).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(rejectApproval(acmeAdmin, approval.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(approveBudgetIncrease(null, approval.id, { newTotal: "500", confirmed: true })).rejects.toMatchObject(
      { code: "unauthenticated" },
    );
    await expect(rejectApproval(null, approval.id)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(await stateOf(id)).toBe("PAUSED_FOR_APPROVAL");
    expect((await mandateOf(id)).totalAuthorizedUnits).toBe(3000n);
    await expect(listApprovals(globex.owner, acme.org)).rejects.toMatchObject({ code: "forbidden" });
    expect(await listApprovals(globex.owner, globex.org)).toEqual([]);
  });

  it("can be declined, which resumes the engagement inside its existing limits", async () => {
    const { id, approval } = await blockedOnBudget();
    const decided = await rejectApproval(acme.owner, approval.id);
    expect(decided.status).toBe("rejected");
    expect(await stateOf(id)).toBe("ACTIVE");
    expect((await mandateOf(id)).totalAuthorizedUnits).toBe(3000n);
    expect((await buy(id, alpha, 4)).status).toBe("paid");
    await expect(rejectApproval(acme.owner, approval.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(
      approveBudgetIncrease(acme.owner, approval.id, { newTotal: "500", confirmed: true }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await mandateOf(id)).totalAuthorizedUnits).toBe(3000n);
  });

  it("can change the proposed work to a permitted service that fits", async () => {
    const { id, approval } = await blockedOnBudget();
    // Not a permitted service of this engagement, or one that does not fit either.
    await expect(
      modifyProposedWork(acme.owner, approval.id, { replacementOfferingId: beta.offering[4] }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      modifyProposedWork(acme.owner, approval.id, { replacementOfferingId: alpha.offering[25] }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      modifyProposedWork(acme.owner, approval.id, { replacementOfferingId: "nonsense" }),
    ).rejects.toMatchObject({ code: "invalid" });

    const decided = await modifyProposedWork(acme.owner, approval.id, {
      replacementOfferingId: alpha.offering[4],
    });
    expect(decided).toMatchObject({ status: "modified", replacementOfferingId: alpha.offering[4] });
    expect(await stateOf(id)).toBe("ACTIVE");
    expect((await mandateOf(id)).totalAuthorizedUnits).toBe(3000n);
    const activity = await getEngagementActivity(acme.owner, id);
    expect(activity.alternatives.map((a) => a.name)).toEqual(["API contract check"]);
  });

  it("are cancelled when the buyer terminates the engagement instead", async () => {
    const { id, approval } = await blockedOnBudget();
    await cancelEngagement(acme.owner, id);
    const [row] = await db
      .select()
      .from(schema.approvalRequests)
      .where(eq(schema.approvalRequests.id, approval.id));
    expect(row.status).toBe("cancelled");
    await expect(
      approveBudgetIncrease(acme.owner, approval.id, { newTotal: "500", confirmed: true }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await mandateOf(id)).totalAuthorizedUnits).toBe(3000n);
  });

  it("allow only one open request per engagement", async () => {
    const { id } = await blockedOnBudget();
    await expect(
      db.insert(schema.approvalRequests).values({
        engagementId: id,
        kind: "budget_increase",
        offeringName: "Second",
        asset: "SIM-USD",
        assetDecimals: 2,
        proposedAmountUnits: 1n,
        totalAuthorizedUnits: 1n,
        spentUnits: 0n,
        reservedUnits: 0n,
        walletBalanceUnits: 0n,
        shortfallUnits: 1n,
      }),
    ).rejects.toThrow();
  });
});
