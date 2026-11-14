import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { completeOnboarding } from "@/server/accounts";
import type { AgentBrain } from "@/server/agent/brain";
import { runAgent } from "@/server/agent/runtime";
import { setSellerTransportResolver } from "@/server/agent/transport";
import { approveBudgetIncrease, listApprovals } from "@/server/approvals";
import { listAuditEvents } from "@/server/audit-log";
import { signInWithAccessToken } from "@/server/auth/identity";
import type { TokenVerifier } from "@/server/auth/verifier";
import type { Actor } from "@/server/authz";
import { getBudgetStatus } from "@/server/budget";
import { completeEngagement, getEngagementStatement, returnUnusedFunds } from "@/server/closure";
import {
  authorizeEngagement,
  authorizeFunding,
  cancelEngagement,
  createEngagement,
  getEngagementDetail,
  provisionEngagementWallet,
  saveMandateDraft,
} from "@/server/engagements";
import { getPublicSellerBySlug, listPublicSellers } from "@/server/marketplace";
import { DemoPaymentProvider } from "@/server/payments/demo";
import type { PaymentProvider } from "@/server/payments/provider";
import { setPaymentProvider, simulatedRecipient } from "@/server/payments/registry";
import { executePurchase, reconcilePurchase } from "@/server/policy";
import { createProject } from "@/server/projects";
import { createOffering, saveSellerEndpoint, updateSellerListing } from "@/server/sellers";
import { getIntegrationStatus } from "@/server/status";
import { claimTestingJob, requeueTestingJob, submitTestingResult } from "@/server/testing/jobs";
import { getTestingReport, listTestingJobs } from "@/server/testing/reports";
import { listPayments } from "@/server/transactions";
import { depositSimulatedFunds, getWalletOverview } from "@/server/wallets";
import { childEnvironment } from "../worker/src/exec.mjs";
import { executeJob } from "../worker/src/job.mjs";
import { supportedPairs } from "../worker/src/plans.mjs";
import { detectTools } from "../worker/src/tools.mjs";
import {
  addMember,
  createUser,
  fixtureProject,
  markSample,
  platformActivate,
  registerWorker,
  useTestDatabase,
  validEndpoint,
  validListing,
} from "./support/db";

let db: Db;
let close: () => Promise<void>;

type Seller = { owner: Actor; org: string; slug: string; id: string; unit: string; api: string };
type Buyer = { owner: Actor; org: string; projectId: string };
let relay: Seller;
let ledger: Seller;
let acme: Buyer;
let acmeAdmin: Actor;
let acmeMember: Actor;
let globex: Buyer;

const tools = await detectTools();
const PAIRS = [`${fixtureProject.fixtureKey}:unit_testing`, `${fixtureProject.fixtureKey}:api_testing`];

/** Sells a $15 unit test run and a $4 API check. */
async function createSeller(label: string): Promise<Seller> {
  const owner = await createUser(db, `${label}-owner`);
  const ws = await completeOnboarding(owner, {
    displayName: `${label} owner`,
    organizationName: `${label} agents`,
    accountType: "business",
    roles: "seller",
  });
  await updateSellerListing(owner, ws.organization.id, {
    ...validListing,
    displayName: `${label} agents`,
    capabilities: ["unit_testing", "api_testing"],
  });
  await saveSellerEndpoint(owner, ws.organization.id, validEndpoint);
  const make = (name: string, capability: string, priceMinor: number) =>
    createOffering(owner, ws.organization.id, { name, description: "", capability, billingUnit: "per_run", priceMinor });
  const unit = await make("Unit test run", "unit_testing", 1500);
  const api = await make("API contract check", "api_testing", 400);
  await platformActivate(db, ws.sellerProfile!.slug);
  await markSample(db, ws.sellerProfile!.slug);
  return { owner, org: ws.organization.id, slug: ws.sellerProfile!.slug, id: ws.sellerProfile!.id, unit: unit.id, api: api.id };
}

async function createBuyer(label: string): Promise<Buyer> {
  const owner = await createUser(db, `${label}-owner`);
  const ws = await completeOnboarding(owner, {
    displayName: `${label} owner`,
    organizationName: `${label} software`,
    accountType: "business",
    roles: "buyer",
  });
  const project = await createProject(owner, ws.organization.id, fixtureProject);
  await depositSimulatedFunds(owner, ws.organization.id, { amount: "1000" });
  return { owner, org: ws.organization.id, projectId: project.id };
}

type Stage = "selected" | "authorized" | "active";
async function engage(buyer: Buyer, seller: Seller, options: { total?: string; fund?: string; stage?: Stage } = {}) {
  const engagement = await createEngagement(buyer.owner, buyer.org, { sellerSlug: seller.slug, projectId: buyer.projectId });
  await saveMandateDraft(buyer.owner, engagement.id, {
    totalBudget: options.total ?? "30",
    perTransactionLimit: "15",
    offeringIds: [seller.unit, seller.api],
    scope: "Run the unit suite and the API checks, and report what fails.",
    expiresInDays: 30,
  });
  if (options.stage === "selected") return engagement.id;
  await authorizeEngagement(buyer.owner, engagement.id, { confirmed: true });
  if (options.stage === "authorized") return engagement.id;
  await provisionEngagementWallet(buyer.owner, engagement.id);
  await authorizeFunding(buyer.owner, engagement.id, {
    amount: options.fund ?? options.total ?? "30",
    idempotencyKey: randomUUID(),
    confirmed: true,
  });
  return engagement.id;
}

/** An agent that proposes exactly these services, in order, then stops. */
function proposing(offeringIds: string[]): AgentBrain {
  const queue = [...offeringIds];
  return {
    name: "test",
    async next() {
      const offeringId = queue.shift();
      return offeringId
        ? { tool: "purchase_service", input: { offeringId, reason: "test" } }
        : { tool: "finish", input: { summary: "Done." } };
    },
  };
}
const run = (actor: Actor | null, id: string, brain?: AgentBrain) =>
  runAgent(actor, id, { runKey: randomUUID() }, brain);

const quoteFor = (id: string, seller: Seller, offeringId: string, units: bigint, overrides: Record<string, unknown> = {}) => ({
  engagementId: id,
  offeringId,
  idempotencyKey: randomUUID(),
  quote: { sellerProfileId: seller.id, asset: "SIM-USD", amountUnits: units, recipient: simulatedRecipient("goat", seller.id) },
  explanation: "test",
  ...overrides,
});

const engagementRow = async (id: string) =>
  (await db.select().from(schema.engagements).where(eq(schema.engagements.id, id)))[0];
const walletOf = async (id: string) =>
  (await db.select().from(schema.engagementWallets).where(eq(schema.engagementWallets.engagementId, id)))[0];
const purchasesOf = (id: string) => db.select().from(schema.purchases).where(eq(schema.purchases.engagementId, id));
const paid = async (id: string) => (await purchasesOf(id)).filter((p) => p.status === "paid" || p.status === "delivered");
const ownerOf = (org: string): Actor => (org === acme.org ? acme.owner : globex.owner);
const masterBalance = async (org: string) => (await getWalletOverview(ownerOf(org), org)).rails[0].unallocatedUnits;

/** A worker picks up one queued job and runs it for real. */
async function workOneJob() {
  const supports = supportedPairs(tools);
  const job = await claimTestingJob({ workerId: "final-worker", tools, supports });
  if (!job) return null;
  await submitTestingResult(job.id, { workerId: "final-worker", result: await executeJob(job, tools) });
  return job.id;
}

function providerWith(overrides: Partial<PaymentProvider>): PaymentProvider {
  const base = new DemoPaymentProvider("goat");
  return {
    rail: base.rail,
    name: base.name,
    simulated: base.simulated,
    validatePaymentRequirement: base.validatePaymentRequirement.bind(base),
    getPaymentStatus: base.getPaymentStatus.bind(base),
    verifyPayment: base.verifyPayment.bind(base),
    initiatePayment: base.initiatePayment.bind(base),
    ...overrides,
  };
}

beforeAll(async () => {
  ({ db, close } = await useTestDatabase());
  relay = await createSeller("relay");
  ledger = await createSeller("ledger");
  acme = await createBuyer("acme");
  globex = await createBuyer("globex");
  acmeAdmin = await createUser(db, "acme-admin");
  acmeMember = await createUser(db, "acme-member");
  await addMember(db, acme.org, acmeAdmin.userId, "admin");
  await addMember(db, acme.org, acmeMember.userId, "member");
});
afterAll(async () => close());
beforeEach(async () => {
  setSellerTransportResolver(undefined);
  await db.delete(schema.testingWorkers);
  await db
    .update(schema.testingJobs)
    .set({ status: "failed", failureReason: "left over from another test" })
    .where(eq(schema.testingJobs.status, "queued"));
  await registerWorker(db, PAIRS);
});
afterEach(() => setPaymentProvider("goat", undefined));

describe("the complete journey", () => {
  it("runs from sign-up to a closed engagement with its final record", { timeout: 180_000 }, async () => {
    // 1. The buyer signs up. Identity comes from a verified token, never from the browser's say-so.
    const verifier: TokenVerifier = {
      async verify(token) {
        if (token !== "valid-token") throw new Error("invalid token");
        return { subject: "did:privy:journey", email: "buyer@journey.example", displayName: "Jo Buyer" };
      },
    };
    await expect(signInWithAccessToken(verifier, "forged-token")).rejects.toMatchObject({ code: "invalid" });
    const user = await signInWithAccessToken(verifier, "valid-token");
    const buyer: Actor = { userId: user.id };
    const ws = await completeOnboarding(buyer, {
      displayName: "Jo Buyer",
      organizationName: "Journey Software",
      accountType: "business",
      roles: "buyer",
    });
    const org = ws.organization.id;

    // 2 and 3. A project, with the Web3 question answered. One form for all software.
    await expect(createProject(buyer, org, { ...fixtureProject, testingAuthorized: false })).rejects.toMatchObject({
      code: "invalid",
    });
    const project = await createProject(buyer, org, fixtureProject);
    expect(project).toMatchObject({ hasWeb3: false, sourceType: "fixture" });

    // 4 and 5. The buyer browses sellers and picks one. Nothing is contacted by browsing.
    const listed = await listPublicSellers();
    expect(listed.map((s) => s.slug)).toEqual(expect.arrayContaining([relay.slug, ledger.slug]));
    expect((await getPublicSellerBySlug(relay.slug))?.offerings).toHaveLength(2);
    const engagement = await createEngagement(buyer, org, { sellerSlug: relay.slug, projectId: project.id });
    const id = engagement.id;
    expect(await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.engagementId, id))).toEqual([]);

    // 6. The buyer sets and authorizes the mandate: $20 in total, $15 a purchase.
    await saveMandateDraft(buyer, id, {
      totalBudget: "20",
      perTransactionLimit: "15",
      offeringIds: [relay.unit, relay.api],
      scope: "Run the unit suite and the API checks, and report what fails.",
      expiresInDays: 30,
    });
    await authorizeEngagement(buyer, id, { confirmed: true });
    expect((await engagementRow(id)).state).toBe("AUTHORIZED");

    // 7. A wallet for this engagement alone. Provisioning moves nothing.
    await provisionEngagementWallet(buyer, id);
    expect(await walletOf(id)).toMatchObject({ status: "awaiting_funding", balanceUnits: 0n });

    // 8. Funding is its own authorization.
    await depositSimulatedFunds(buyer, org, { amount: "200" });
    await authorizeFunding(buyer, id, { amount: "20", idempotencyKey: randomUUID(), confirmed: true });
    expect((await engagementRow(id)).state).toBe("ACTIVE");

    // 9. The agent buys an authorized test.
    const first = await run(buyer, id, proposing([relay.unit]));
    expect(first.run).toMatchObject({ status: "completed", purchasesCompleted: 1 });

    // 10. The test genuinely executes, in the worker, against the fixture.
    const jobId = await workOneJob();
    expect(jobId).not.toBeNull();

    // 11. The payment and the results are there to see.
    const report = await getTestingReport(buyer, jobId!);
    expect(report.result).toMatchObject({ outcome: "failed", tool: "vitest", testsTotal: 6, testsPassed: 5, testsFailed: 1 });
    expect(report.chargeUnits).toBe(1500n);
    expect(report.paymentReference).toContain("demo-payment:goat:");
    expect((await listPayments(buyer, org))[0]).toMatchObject({ status: "succeeded", amountUnits: 1500n });
    expect((await listTestingJobs(buyer, org))[0].result?.summary).toBe("Vitest ran 6 tests: 5 passed, 1 failed.");

    // 12 and 13. The next purchase would take spending to $30 against a $20 budget. It is blocked.
    const second = await run(buyer, id, proposing([relay.unit]));
    expect(second.run).toMatchObject({ status: "paused", purchasesCompleted: 0 });
    expect((await engagementRow(id)).state).toBe("PAUSED_FOR_APPROVAL");
    expect(await getBudgetStatus(db, id)).toMatchObject({ spentUnits: 1500n, reservedUnits: 0n, walletBalanceUnits: 500n });
    const blocked = (await purchasesOf(id)).find((p) => p.status === "blocked");
    expect(blocked?.blockReason).toBe("budget_exceeded");

    // 14. The buyer reviews what the first test found before deciding.
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ severity: "medium", category: "test_failure" });
    expect(report.findings[0].evidence).toContain("AssertionError");

    // 15. The buyer approves a higher budget. That changes the budget and nothing else.
    const [approval] = (await listApprovals(buyer, org)).filter((a) => a.status === "pending");
    await approveBudgetIncrease(buyer, approval.id, { newTotal: "40", confirmed: true });
    expect(await getBudgetStatus(db, id)).toMatchObject({ totalUnits: 4000n, walletBalanceUnits: 500n });

    // 16. The wallet still holds $5, so the same purchase now needs funds. That is a separate authorization.
    const starved = await run(buyer, id, proposing([relay.unit]));
    expect(starved.run.status).toBe("paused");
    expect((await listApprovals(buyer, org)).find((a) => a.status === "pending")?.kind).toBe("additional_funding");
    await authorizeFunding(buyer, id, { amount: "20", idempotencyKey: randomUUID(), confirmed: true });
    expect((await engagementRow(id)).state).toBe("ACTIVE");

    // 17. The agent resumes the work.
    const resumed = await run(buyer, id, proposing([relay.unit]));
    expect(resumed.run).toMatchObject({ status: "completed", purchasesCompleted: 1 });
    expect(await workOneJob()).not.toBeNull();
    expect(await getBudgetStatus(db, id)).toMatchObject({ spentUnits: 3000n, walletBalanceUnits: 1000n });

    // 18. The engagement closes, and its final financial record is complete and reconciles.
    await completeEngagement(buyer, id);
    expect((await engagementRow(id)).state).toBe("COMPLETED");
    await expect(run(buyer, id, proposing([relay.api]))).rejects.toMatchObject({ code: "conflict" });
    const statement = (await getEngagementStatement(buyer, id))!;
    expect(statement).toMatchObject({
      state: "COMPLETED",
      fundedUnits: 4000n,
      spentUnits: 3000n,
      returnedUnits: 0n,
      heldUnits: 1000n,
      reconciles: true,
      unresolved: 0,
      canReturn: true,
      tests: { queued: 0, running: 0, completed: 2, failed: 0 },
    });
    expect(statement.payments).toHaveLength(2);
    expect(statement.fundings).toHaveLength(2);

    // The unused $10 goes back only when the buyer says so, and only to where it came from.
    const before = (await getWalletOverview(buyer, org)).rails[0].unallocatedUnits;
    await returnUnusedFunds(buyer, id, { idempotencyKey: randomUUID(), confirmed: true });
    const after = (await getEngagementStatement(buyer, id))!;
    expect(after).toMatchObject({ returnedUnits: 1000n, heldUnits: 0n, reconciles: true, canReturn: false });
    expect((await getWalletOverview(buyer, org)).rails[0].unallocatedUnits).toBe(before + 1000n);
    expect((await walletOf(id)).status).toBe("closed");

    // Every sensitive step along the way is in the organization's log.
    const actions = (await listAuditEvents(buyer, org)).map((event) => event.action);
    for (const action of [
      "organization.created",
      "project.created",
      "engagement.seller_selected",
      "engagement.authorized",
      "engagement_wallet.provisioned",
      "funding.authorized",
      "mandate.budget_increased",
      "engagement.completed",
      "funds.returned",
    ]) {
      expect(actions, action).toContain(action);
    }
  });
});

describe("a second engagement with another seller", () => {
  it("has its own wallet, its own mandate and its own agent, and neither can reach the other", async () => {
    const first = await engage(acme, relay, { total: "30" });
    const second = await engage(acme, ledger, { total: "50" });

    // Separate wallets.
    const [walletA, walletB] = [await walletOf(first), await walletOf(second)];
    expect(walletA.id).not.toBe(walletB.id);
    expect(walletA.providerRef).not.toBe(walletB.providerRef);

    // Independent mandates: spending under one leaves the other untouched.
    await run(acme.owner, first, proposing([relay.unit]));
    expect(await getBudgetStatus(db, first)).toMatchObject({ totalUnits: 3000n, spentUnits: 1500n, walletBalanceUnits: 1500n });
    expect(await getBudgetStatus(db, second)).toMatchObject({ totalUnits: 5000n, spentUnits: 0n, walletBalanceUnits: 5000n });

    // One engagement's agent cannot buy from the other's seller, or use the other's funds.
    const crossed = await executePurchase(quoteFor(first, ledger, ledger.unit, 1500n));
    expect(crossed).toMatchObject({ status: "blocked", reason: "wrong_seller" });
    expect((await walletOf(second)).balanceUnits).toBe(5000n);
    await expect(
      db.insert(schema.fundingAuthorizations).values({
        engagementId: first,
        engagementWalletId: walletB.id,
        masterWalletAccountId: (await db.select().from(schema.masterWalletAccounts).where(eq(schema.masterWalletAccounts.organizationId, acme.org)))[0].id,
        rail: "goat",
        asset: "SIM-USD",
        amountUnits: 100n,
        idempotencyKey: randomUUID(),
        authorizedBy: acme.owner.userId,
      }),
    ).rejects.toThrow();

    // A seller cannot change its buyer's permissions, or even see the engagement.
    await expect(approveBudgetIncrease(relay.owner, randomUUID(), { newTotal: "9999", confirmed: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(getEngagementDetail(relay.owner, first)).rejects.toMatchObject({ code: "not_found" });
    await expect(authorizeFunding(relay.owner, first, { amount: "5", idempotencyKey: randomUUID(), confirmed: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(completeEngagement(relay.owner, first)).rejects.toMatchObject({ code: "not_found" });
    await expect(returnUnusedFunds(ledger.owner, second, { idempotencyKey: randomUUID(), confirmed: true })).rejects.toMatchObject({ code: "not_found" });

    // Ending one leaves the other running, and its leftover funds are never moved across.
    await cancelEngagement(acme.owner, first);
    expect((await engagementRow(second)).state).toBe("ACTIVE");
    await returnUnusedFunds(acme.owner, first, { idempotencyKey: randomUUID(), confirmed: true });
    expect((await walletOf(second)).balanceUnits).toBe(5000n);
    expect((await run(acme.owner, second, proposing([ledger.api]))).run.purchasesCompleted).toBe(1);
  });
});

describe("the eighteen invariants", () => {
  it("1. no agent-to-agent activity before the engagement is authorized and active", async () => {
    for (const stage of ["selected", "authorized"] as const) {
      const id = await engage(acme, relay, { stage });
      await expect(run(acme.owner, id), stage).rejects.toMatchObject({ code: "conflict" });
      await expect(
        db.insert(schema.agentMessages).values({ engagementId: id, sellerProfileId: relay.id, direction: "agent_to_seller", kind: "quote_request", body: {} }),
        stage,
      ).rejects.toThrow();
      expect(await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.engagementId, id))).toEqual([]);
    }
  });

  it("2. a seller cannot activate a purchasing agent", async () => {
    const id = await engage(acme, relay);
    await expect(run(relay.owner, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(authorizeEngagement(relay.owner, await engage(acme, relay, { stage: "selected" }), { confirmed: true })).rejects.toMatchObject({ code: "not_found" });
    expect(await purchasesOf(id)).toEqual([]);
  });

  it("3. a buyer's agent cannot choose a new seller", async () => {
    const id = await engage(acme, relay);
    const result = await run(acme.owner, id, proposing([ledger.unit, ledger.api]));
    expect(result.run.purchasesCompleted).toBe(0);
    expect(await paid(id)).toEqual([]);
    await expect(db.update(schema.engagements).set({ sellerProfileId: ledger.id }).where(eq(schema.engagements.id, id))).rejects.toThrow();
  });

  it("4. a buyer's agent cannot spend from the master wallet", async () => {
    const id = await engage(acme, relay, { total: "30", fund: "15" });
    const before = await masterBalance(acme.org);
    // It has no tool for it, and proposing one changes nothing.
    const greedy: AgentBrain = {
      name: "greedy",
      async next() {
        return { tool: "transfer_from_master", input: { amount: "1000" } };
      },
    };
    expect((await run(acme.owner, id, greedy)).run.status).toBe("failed");
    // With its own wallet exhausted it must stop and ask; it cannot reach past it.
    await run(acme.owner, id, proposing([relay.unit, relay.unit]));
    expect(await paid(id)).toHaveLength(1);
    expect(await masterBalance(acme.org)).toBe(before);
    expect((await engagementRow(id)).state).toBe("PAUSED_FOR_APPROVAL");
  });

  it("5. engagement wallets cannot access each other's funds", async () => {
    const poor = await engage(acme, relay, { total: "30", fund: "4" });
    const rich = await engage(acme, relay, { total: "30", fund: "30" });
    const outcome = await executePurchase(quoteFor(poor, relay, relay.unit, 1500n));
    expect(outcome).toMatchObject({ status: "blocked", reason: "insufficient_wallet_funds" });
    expect((await walletOf(rich)).balanceUnits).toBe(3000n);
    expect((await walletOf(poor)).balanceUnits).toBe(400n);
  });

  it("6. agent payments cannot exceed approved limits", async () => {
    const id = await engage(acme, relay, { total: "30" });
    // Over the per-purchase limit ($15), by quantity.
    expect(await executePurchase({ ...quoteFor(id, relay, relay.unit, 3000n), quantity: 2 })).toMatchObject({ status: "blocked", reason: "per_purchase_limit" });
    await executePurchase(quoteFor(id, relay, relay.unit, 1500n));
    await executePurchase(quoteFor(id, relay, relay.unit, 1500n));
    // The budget is spent: even $4 more is refused.
    expect(await executePurchase(quoteFor(id, relay, relay.api, 400n))).toMatchObject({ status: "blocked", reason: "budget_exceeded" });
    expect(await getBudgetStatus(db, id)).toMatchObject({ spentUnits: 3000n, remainingUnits: 0n });
  });

  it("7. concurrent payments cannot bypass the budget", async () => {
    const id = await engage(acme, relay, { total: "30" });
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => executePurchase(quoteFor(id, relay, relay.unit, 1500n))));
    expect(outcomes.filter((o) => o.status === "paid")).toHaveLength(2);
    expect(await getBudgetStatus(db, id)).toMatchObject({ spentUnits: 3000n, reservedUnits: 0n, walletBalanceUnits: 0n });
  });

  it("8. duplicate payment requests do not cause duplicate charges", async () => {
    const id = await engage(acme, relay);
    const request = quoteFor(id, relay, relay.unit, 1500n);
    // Sent three times at once: one pays, and the others are told the truth, which is that it is in hand.
    const together = await Promise.all([executePurchase(request), executePurchase(request), executePurchase(request)]);
    expect(together.filter((o) => o.status === "paid" && !o.replayed)).toHaveLength(1);
    expect(together.every((o) => o.status === "paid" || o.status === "needs_reconciliation")).toBe(true);
    expect(new Set(together.map((o) => o.purchase?.id)).size).toBe(1);
    // Sent again afterwards: the first outcome comes back, and nothing is paid.
    expect(await executePurchase(request)).toMatchObject({ status: "paid", replayed: true });
    expect(await db.select().from(schema.paymentTransactions).where(eq(schema.paymentTransactions.engagementId, id))).toHaveLength(1);
    expect(await getBudgetStatus(db, id)).toMatchObject({ spentUnits: 1500n });
  });

  it("9. a seller cannot redirect payment to an unauthorized address", async () => {
    const id = await engage(acme, relay);
    const redirected = quoteFor(id, relay, relay.unit, 1500n);
    redirected.quote.recipient = simulatedRecipient("goat", ledger.id);
    expect(await executePurchase(redirected)).toMatchObject({ status: "blocked", reason: "recipient_not_authorized" });
    expect(await paid(id)).toEqual([]);
  });

  it("10. unauthenticated users cannot approve spending", async () => {
    const id = await engage(acme, relay, { total: "15" });
    await run(acme.owner, id, proposing([relay.unit, relay.unit]));
    const approval = (await listApprovals(acme.owner, acme.org)).find((a) => a.status === "pending" && a.engagementId === id)!;
    await expect(approveBudgetIncrease(null, approval.id, { newTotal: "500", confirmed: true })).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(authorizeFunding(null, id, { amount: "5", idempotencyKey: randomUUID(), confirmed: true })).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(authorizeEngagement(null, id, { confirmed: true })).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(returnUnusedFunds(null, id, { idempotencyKey: randomUUID(), confirmed: true })).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("11. budget increases require the owner's explicit authorization", async () => {
    const id = await engage(acme, relay, { total: "15" });
    await run(acme.owner, id, proposing([relay.unit, relay.unit]));
    const approval = (await listApprovals(acme.owner, acme.org)).find((a) => a.status === "pending" && a.engagementId === id)!;
    await expect(approveBudgetIncrease(acmeAdmin, approval.id, { newTotal: "500", confirmed: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(approveBudgetIncrease(acmeMember, approval.id, { newTotal: "500", confirmed: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(approveBudgetIncrease(globex.owner, approval.id, { newTotal: "500", confirmed: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(approveBudgetIncrease(acme.owner, approval.id, { newTotal: "500", confirmed: false })).rejects.toMatchObject({ code: "invalid" });
    expect((await getBudgetStatus(db, id))?.totalUnits).toBe(1500n);
    // The agent cannot raise it either: it has no such tool.
    const pushy: AgentBrain = { name: "pushy", async next() { return { tool: "increase_budget", input: { total: "500" } }; } };
    await approveBudgetIncrease(acme.owner, approval.id, { newTotal: "30", confirmed: true });
    await run(acme.owner, id, pushy);
    expect((await getBudgetStatus(db, id))?.totalUnits).toBe(3000n);
  });

  it("12. additional funding requires its own authorization", async () => {
    const id = await engage(acme, relay, { total: "15" });
    await run(acme.owner, id, proposing([relay.unit, relay.unit]));
    const approval = (await listApprovals(acme.owner, acme.org)).find((a) => a.status === "pending" && a.engagementId === id)!;
    const master = await masterBalance(acme.org);
    await approveBudgetIncrease(acme.owner, approval.id, { newTotal: "500", confirmed: true });
    // A bigger budget moved no money.
    expect((await walletOf(id)).balanceUnits).toBe(0n);
    expect(await masterBalance(acme.org)).toBe(master);
    expect(await executePurchase(quoteFor(id, relay, relay.unit, 1500n))).toMatchObject({ status: "blocked", reason: "insufficient_wallet_funds" });
    await expect(authorizeFunding(acmeAdmin, id, { amount: "15", idempotencyKey: randomUUID(), confirmed: true })).rejects.toMatchObject({ code: "forbidden" });
    await expect(authorizeFunding(acme.owner, id, { amount: "15", idempotencyKey: randomUUID(), confirmed: false })).rejects.toMatchObject({ code: "invalid" });
  });

  it("13. suspended, ended or expired engagements cannot purchase", async () => {
    const cancelled = await engage(acme, relay);
    await cancelEngagement(acme.owner, cancelled);
    const completed = await engage(acme, relay);
    await completeEngagement(acme.owner, completed);
    const expired = await engage(acme, relay);
    await db.update(schema.engagements).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.engagements.id, expired));
    const paused = await engage(acme, relay, { total: "15" });
    await run(acme.owner, paused, proposing([relay.unit, relay.unit]));

    for (const [label, id] of [["cancelled", cancelled], ["completed", completed], ["expired", expired], ["paused", paused]] as const) {
      const outcome = await executePurchase(quoteFor(id, relay, relay.api, 400n));
      expect(outcome.status, label).toBe("blocked");
    }
    expect(await paid(cancelled)).toEqual([]);
    expect((await engagementRow(expired)).state).toBe("EXPIRED");
  });

  it("14. Qatom funds cannot be treated as GOAT funds", async () => {
    const buyer = await createBuyerWithoutFunds("rail");
    // An account left over from when Qatom was offered as a simulated rail, holding plenty.
    await db.insert(schema.masterWalletAccounts).values({
      organizationId: buyer.org,
      rail: "qatom",
      asset: "USD-TDN",
      assetDecimals: 2,
      provider: "simulated",
      providerRef: `sim-master:qatom:${randomUUID()}`,
      balanceUnits: 100000n,
    });
    const id = await engage(buyer, relay, { stage: "authorized" });
    await provisionEngagementWallet(buyer.owner, id);
    const error = await authorizeFunding(buyer.owner, id, { amount: "10", idempotencyKey: randomUUID(), confirmed: true }).catch((e) => e);
    expect(error.fieldErrors.amount).toBeDefined();
    expect((await walletOf(id)).balanceUnits).toBe(0n);
    await expect(saveMandateDraft(buyer.owner, await engage(buyer, relay, { stage: "selected" }), { rail: "qatom", totalBudget: "10", perTransactionLimit: "5", offeringIds: [relay.api], scope: "Pay through another network.", expiresInDays: 5 })).rejects.toMatchObject({ code: "invalid" });
  });

  it("15. a payment is verified before success is recorded", async () => {
    const id = await engage(acme, relay);
    // The provider says it paid, but the independent check does not agree.
    setPaymentProvider("goat", providerWith({ verifyPayment: async () => false }));
    const outcome = await executePurchase(quoteFor(id, relay, relay.unit, 1500n));
    expect(outcome.status).not.toBe("paid");
    expect(await paid(id)).toEqual([]);
    expect(await db.select().from(schema.paymentTransactions).where(eq(schema.paymentTransactions.engagementId, id))).toEqual([]);
    expect((await getBudgetStatus(db, id))?.spentUnits).toBe(0n);
  });

  it("16. testing workers cannot access wallet signing credentials", async () => {
    const environment: Record<string, string> = childEnvironment({
      PATH: "/usr/bin",
      PRIVY_APP_SECRET: "x".repeat(40),
      GOATX402_API_SECRET: "x".repeat(40),
      SESSION_SECRET: "x".repeat(40),
      DATABASE_URL: "postgres://secret",
      WORKER_TOKEN: "x".repeat(40),
    } as unknown as NodeJS.ProcessEnv);
    expect(Object.keys(environment).filter((key) => /SECRET|TOKEN|DATABASE|PRIVY|GOAT/.test(key))).toEqual([]);
    // What a worker is handed names a fixture and a test type. No wallet, engagement or credential.
    const id = await engage(acme, relay);
    await run(acme.owner, id, proposing([relay.api]));
    const job = await claimTestingJob({ workerId: "inv-worker", tools: { vitest: "x" }, supports: PAIRS });
    expect(Object.keys(job!).sort()).toEqual(["capability", "fixtureKey", "id"]);
  });

  it("17. a failed or uncertain payment is not retried in a way that could double-charge", async () => {
    const id = await engage(acme, relay);
    let attempts = 0;
    setPaymentProvider(
      "goat",
      providerWith({
        initiatePayment: async () => {
          attempts += 1;
          throw new Error("connection lost after sending");
        },
        getPaymentStatus: async () => ({ status: "unknown" }),
      }),
    );
    await run(acme.owner, id, proposing([relay.unit, relay.unit]));
    const [purchase] = await purchasesOf(id);
    expect(purchase.status).toBe("needs_reconciliation");
    expect(attempts).toBe(1);
    // Reconciling asks what happened. It never sends the payment again.
    await reconcilePurchase(acme.owner, purchase.id);
    expect(attempts).toBe(1);
    // Until it is settled nothing else is bought: buying the same thing again could pay twice.
    await run(acme.owner, id, proposing([relay.unit]));
    expect(await executePurchase(quoteFor(id, relay, relay.api, 400n))).toMatchObject({ status: "blocked", reason: "payment_unresolved" });
    expect(attempts).toBe(1);
    expect(await getBudgetStatus(db, id)).toMatchObject({ spentUnits: 0n, reservedUnits: 1500n });

    // A definite failure charges nothing and is not retried either.
    const failing = await engage(acme, relay);
    let failures = 0;
    setPaymentProvider("goat", providerWith({ initiatePayment: async () => { failures += 1; return { status: "failed", reason: "declined" }; } }));
    await run(acme.owner, failing, proposing([relay.unit]));
    expect(failures).toBe(1);
    expect(await getBudgetStatus(db, failing)).toMatchObject({ spentUnits: 0n, reservedUnits: 0n, walletBalanceUnits: 3000n });
  });

  it("18. real test results are not fabricated", async () => {
    const id = await engage(acme, relay);
    await run(acme.owner, id, proposing([relay.unit]));
    // Paying is not a result: until a worker reports, nothing is claimed.
    const [purchase] = await purchasesOf(id);
    expect(purchase).toMatchObject({ status: "paid", delivery: null });
    const said = JSON.stringify(await db.select().from(schema.agentMessages).where(eq(schema.agentMessages.engagementId, id)));
    for (const word of ["passed", "testsTotal", "findings", "severity"]) expect(said, word).not.toContain(word);

    // A report that contradicts itself, or comes from the wrong tool, is refused whole.
    const job = (await claimTestingJob({ workerId: "inv-worker", tools: { vitest: "x" }, supports: PAIRS }))!;
    const report = { outcome: "passed", tool: "vitest", durationMs: 5, testsTotal: 6, testsPassed: 6, testsFailed: 1, testsSkipped: 0, findings: [] };
    await expect(submitTestingResult(job.id, { workerId: "inv-worker", result: report })).rejects.toMatchObject({ code: "invalid" });
    await expect(submitTestingResult(job.id, { workerId: "inv-worker", result: { ...report, testsFailed: 0, tool: "forge" } })).rejects.toMatchObject({ code: "invalid" });
    await expect(submitTestingResult(job.id, { workerId: "someone-else", result: { ...report, testsFailed: 0 } })).rejects.toMatchObject({ code: "conflict" });
    expect(await db.select().from(schema.testingResults).where(eq(schema.testingResults.jobId, job.id))).toEqual([]);
    expect((await purchasesOf(id))[0].status).toBe("paid");
  });
});

async function createBuyerWithoutFunds(label: string): Promise<Buyer> {
  const owner = await createUser(db, `${label}-owner`);
  const ws = await completeOnboarding(owner, {
    displayName: `${label} owner`,
    organizationName: `${label} software`,
    accountType: "business",
    roles: "buyer",
  });
  const project = await createProject(owner, ws.organization.id, fixtureProject);
  return { owner, org: ws.organization.id, projectId: project.id };
}

describe("closing an engagement", () => {
  it("is the owner's decision, is final, and needs the engagement to have started", async () => {
    const id = await engage(acme, relay);
    await expect(completeEngagement(acmeAdmin, id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(completeEngagement(globex.owner, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(completeEngagement(acme.owner, await engage(acme, relay, { stage: "authorized" }))).rejects.toMatchObject({ code: "conflict" });
    expect((await completeEngagement(acme.owner, id)).state).toBe("COMPLETED");
    await expect(completeEngagement(acme.owner, id)).rejects.toMatchObject({ code: "conflict" });
    await expect(cancelEngagement(acme.owner, id)).rejects.toMatchObject({ code: "conflict" });
    expect(await walletOf(id)).toMatchObject({ status: "closing", balanceUnits: 3000n });
  });

  it("returns unused funds only when the owner says so, once, to where they came from", async () => {
    const id = await engage(acme, relay);
    const attempt = (actor: Actor | null, input: Record<string, unknown> = {}) =>
      returnUnusedFunds(actor, id, { idempotencyKey: randomUUID(), confirmed: true, ...input });

    // Not while it is running.
    await expect(attempt(acme.owner)).rejects.toMatchObject({ code: "conflict" });
    await run(acme.owner, id, proposing([relay.unit]));
    await cancelEngagement(acme.owner, id);
    // Nothing moves by itself when an engagement ends.
    expect(await walletOf(id)).toMatchObject({ status: "closing", balanceUnits: 1500n });

    await expect(attempt(acmeAdmin)).rejects.toMatchObject({ code: "forbidden" });
    await expect(attempt(acme.owner, { confirmed: false })).rejects.toMatchObject({ code: "invalid" });
    await expect(attempt(acme.owner, { idempotencyKey: "short" })).rejects.toMatchObject({ code: "invalid" });

    const master = await masterBalance(acme.org);
    const key = randomUUID();
    const returned = await attempt(acme.owner, { idempotencyKey: key });
    expect(returned).toMatchObject({ status: "executed", amountUnits: 1500n, isSimulated: true });
    expect(await masterBalance(acme.org)).toBe(master + 1500n);
    expect(await walletOf(id)).toMatchObject({ status: "closed", balanceUnits: 0n });
    // The same authorization again does nothing; a new one has nothing to return.
    expect((await attempt(acme.owner, { idempotencyKey: key })).id).toBe(returned.id);
    await expect(attempt(acme.owner)).rejects.toMatchObject({ code: "conflict" });
    expect(await masterBalance(acme.org)).toBe(master + 1500n);
    await expect(
      db.insert(schema.fundReturns).values({ ...returned, id: randomUUID(), idempotencyKey: randomUUID(), status: "authorized" }),
    ).rejects.toThrow();
    expect((await getEngagementStatement(acme.owner, id))!).toMatchObject({ fundedUnits: 3000n, spentUnits: 1500n, returnedUnits: 1500n, heldUnits: 0n, reconciles: true });
  });

  it("holds the funds while any payment's outcome is still unknown", async () => {
    const id = await engage(acme, relay);
    setPaymentProvider("goat", providerWith({ initiatePayment: async () => { throw new Error("lost"); }, getPaymentStatus: async () => ({ status: "unknown" }) }));
    await run(acme.owner, id, proposing([relay.unit]));
    await cancelEngagement(acme.owner, id);
    const statement = (await getEngagementStatement(acme.owner, id))!;
    expect(statement).toMatchObject({ unresolved: 1, canReturn: false, reservedUnits: 1500n });
    expect(statement.returnBlockedBy).toContain("Reconcile");
    await expect(returnUnusedFunds(acme.owner, id, { idempotencyKey: randomUUID(), confirmed: true })).rejects.toMatchObject({ code: "conflict" });
    expect((await walletOf(id)).balanceUnits).toBe(3000n);
  });

  it("gives the final record to the buying organization and nobody else", async () => {
    const id = await engage(acme, relay);
    await completeEngagement(acme.owner, id);
    expect((await getEngagementStatement(acmeMember, id))?.state).toBe("COMPLETED");
    for (const outsider of [globex.owner, relay.owner]) {
      await expect(getEngagementStatement(outsider, id)).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(getEngagementStatement(null, id)).rejects.toMatchObject({ code: "unauthenticated" });
    expect(await getEngagementStatement(acme.owner, await engage(acme, relay, { stage: "selected" }))).toBeNull();
  });
});

describe("recovering a test that could not run", () => {
  async function failedJob() {
    const id = await engage(acme, relay);
    await run(acme.owner, id, proposing([relay.unit]));
    const job = (await claimTestingJob({ workerId: "rec-worker", tools: { vitest: "x" }, supports: PAIRS }))!;
    await submitTestingResult(job.id, {
      workerId: "rec-worker",
      result: { outcome: "error", tool: "vitest", durationMs: 120000, error: "The run exceeded its time limit and was stopped.", findings: [] },
    });
    return { id, jobId: job.id };
  }

  it("runs it again at no charge, for owners and admins of the buyer", { timeout: 120_000 }, async () => {
    const { id, jobId } = await failedJob();
    const spent = (await getBudgetStatus(db, id))!.spentUnits;
    await expect(requeueTestingJob(acmeMember, jobId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(requeueTestingJob(relay.owner, jobId)).rejects.toMatchObject({ code: "not_found" });
    await expect(requeueTestingJob(null, jobId)).rejects.toMatchObject({ code: "unauthenticated" });

    const queued = await requeueTestingJob(acmeAdmin, jobId);
    expect(queued).toMatchObject({ status: "queued", attempts: 0, failureReason: null });
    // No new purchase, no new payment, nothing more spent.
    expect(await purchasesOf(id)).toHaveLength(1);
    expect((await getBudgetStatus(db, id))!.spentUnits).toBe(spent);

    expect(await workOneJob()).toBe(jobId);
    expect((await getTestingReport(acme.owner, jobId)).result).toMatchObject({ outcome: "failed", testsTotal: 6, testsFailed: 1 });
    expect((await purchasesOf(id))[0].status).toBe("delivered");
    // A test that ran to completion cannot be run again this way.
    await expect(requeueTestingJob(acme.owner, jobId)).rejects.toMatchObject({ code: "conflict" });
    expect((await listAuditEvents(acme.owner, acme.org)).some((e) => e.action === "testing_job.requeued")).toBe(true);
  });

  it("does not queue it when no worker could run it", async () => {
    const { jobId } = await failedJob();
    await db.delete(schema.testingWorkers);
    await expect(requeueTestingJob(acme.owner, jobId)).rejects.toMatchObject({ code: "conflict" });
    const [job] = await db.select().from(schema.testingJobs).where(eq(schema.testingJobs.id, jobId));
    expect(job.status).toBe("failed");
  });
});

describe("the organization's record and status", () => {
  it("shows the activity log to owners and admins of that organization only", async () => {
    const events = await listAuditEvents(acme.owner, acme.org);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].createdAt.getTime()).toBeGreaterThanOrEqual(events.at(-1)!.createdAt.getTime());
    expect((await listAuditEvents(acmeAdmin, acme.org)).length).toBe(events.length);
    await expect(listAuditEvents(acmeMember, acme.org)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listAuditEvents(globex.owner, acme.org)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listAuditEvents(null, acme.org)).rejects.toMatchObject({ code: "unauthenticated" });
    // Nothing secret is ever written to it.
    const text = JSON.stringify(events);
    for (const secret of ["Sealed", "access_token", "custodyRef", "privy-wallet", "apiSecret"]) expect(text, secret).not.toContain(secret);
    expect((await listAuditEvents(globex.owner, globex.org)).every((e) => !text.includes(e.id))).toBe(true);
  });

  it("says truthfully what is live, simulated or off, and names missing settings to owners only", async () => {
    const status = await getIntegrationStatus(acme.owner, acme.org);
    const byName = Object.fromEntries(status.map((line) => [line.name, line]));
    expect(byName["Testing worker"]).toMatchObject({ state: "live" });
    expect(byName["GOAT identity"]).toMatchObject({ state: "live" });
    expect(byName["GOAT payments"]).toMatchObject({ state: "simulated" });
    expect(byName["GOAT payments"].missing.length).toBeGreaterThan(0);
    expect(byName["Qatom"].state).toBe("simulated");

    await db.delete(schema.testingWorkers);
    const offline = await getIntegrationStatus(acme.owner, acme.org);
    expect(offline.find((line) => line.name === "Testing worker")).toMatchObject({ state: "off" });

    // A member sees the state, not what to configure.
    const forMember = await getIntegrationStatus(acmeMember, acme.org);
    expect(forMember.every((line) => line.missing.length === 0)).toBe(true);
    await expect(getIntegrationStatus(globex.owner, acme.org)).rejects.toMatchObject({ code: "forbidden" });
    // Setting names only: never a value.
    process.env.GOATX402_API_SECRET = "super-secret-value";
    expect(JSON.stringify(await getIntegrationStatus(acme.owner, acme.org))).not.toContain("super-secret-value");
    delete process.env.GOATX402_API_SECRET;
  });
});
