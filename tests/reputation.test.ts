import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { keccak256, stringToBytes } from "viem";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { completeOnboarding } from "@/server/accounts";
import type { AgentBrain } from "@/server/agent/brain";
import { runAgent } from "@/server/agent/runtime";
import { setSellerTransportResolver } from "@/server/agent/transport";
import { listAuditEvents } from "@/server/audit-log";
import type { Actor } from "@/server/authz";
import {
  authorizeEngagement,
  authorizeFunding,
  createEngagement,
  provisionEngagementWallet,
  saveMandateDraft,
} from "@/server/engagements";
import { buyerRegistrationDocument, registrationIsHostedAt, sellerRegistrationDocument } from "@/server/identity";
import { createProject } from "@/server/projects";
import {
  decideCase,
  getCaseForOperator,
  getEngagementFeedback,
  getRatingDocument,
  getSellerReputation,
  getSellerReputationBySlug,
  isPlatformOperator,
  listCasesForOperator,
  listSellerFeedback,
  rateEngagement,
  reportProblem,
  respondToCase,
} from "@/server/reputation";
import { createOffering, saveSellerEndpoint, updateSellerListing } from "@/server/sellers";
import { depositSimulatedFunds } from "@/server/wallets";
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

type Seller = { owner: Actor; org: string; slug: string; id: string; offering: string };
type Buyer = { owner: Actor; org: string; projectId: string };
let relay: Seller;
let ledger: Seller;
let acme: Buyer;
let globex: Buyer;
let acmeAdmin: Actor;
let acmeMember: Actor;
let operator: Actor & { email: string };
let stranger: Actor & { email: string };

const PROBLEM = "The report says six tests ran, but the suite has twelve. Half of it was skipped.";
const VERDICT = { verdict: "upheld", score: 30, note: "The worker's record shows only the unit suite was run.", confirmed: true };

async function createSeller(label: string): Promise<Seller> {
  const owner = await createUser(db, `${label}-owner`);
  const ws = await completeOnboarding(owner, {
    displayName: `${label} owner`,
    organizationName: `${label} agents`,
    accountType: "business",
    roles: "seller",
  });
  await updateSellerListing(owner, ws.organization.id, { ...validListing, displayName: `${label} agents`, capabilities: ["unit_testing"] });
  await saveSellerEndpoint(owner, ws.organization.id, validEndpoint);
  const offering = await createOffering(owner, ws.organization.id, {
    name: "Unit test run",
    description: "",
    capability: "unit_testing",
    billingUnit: "per_run",
    priceMinor: 1000,
  });
  await platformActivate(db, ws.sellerProfile!.slug);
  await markSample(db, ws.sellerProfile!.slug);
  return { owner, org: ws.organization.id, slug: ws.sellerProfile!.slug, id: ws.sellerProfile!.id, offering: offering.id };
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
  await depositSimulatedFunds(owner, ws.organization.id, { amount: "5000" });
  return { owner, org: ws.organization.id, projectId: project.id };
}

const buyOnce = (offeringId: string): AgentBrain => {
  let bought = false;
  return {
    name: "test",
    async next() {
      if (bought) return { tool: "finish", input: { summary: "Done." } };
      bought = true;
      return { tool: "purchase_service", input: { offeringId, reason: "test" } };
    },
  };
};

/** An active engagement, with one paid purchase unless told otherwise. */
async function engaged(buyer: Buyer, seller: Seller, options: { buy?: boolean } = {}): Promise<string> {
  const engagement = await createEngagement(buyer.owner, buyer.org, { sellerSlug: seller.slug, projectId: buyer.projectId });
  await saveMandateDraft(buyer.owner, engagement.id, {
    totalBudget: "50",
    perTransactionLimit: "10",
    offeringIds: [seller.offering],
    scope: "Run the unit suite and report what fails.",
    expiresInDays: 30,
  });
  await authorizeEngagement(buyer.owner, engagement.id, { confirmed: true });
  await provisionEngagementWallet(buyer.owner, engagement.id);
  await authorizeFunding(buyer.owner, engagement.id, { amount: "50", idempotencyKey: randomUUID(), confirmed: true });
  if (options.buy !== false) {
    await runAgent(buyer.owner, engagement.id, { runKey: randomUUID() }, buyOnce(seller.offering));
  }
  return engagement.id;
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
  operator = await createUser(db, "validator");
  stranger = await createUser(db, "stranger");
});
afterAll(async () => close());
beforeEach(async () => {
  setSellerTransportResolver(undefined);
  await db.delete(schema.testingWorkers);
  await registerWorker(db, [`${fixtureProject.fixtureKey}:unit_testing`]);
  process.env.PLATFORM_OPERATOR_EMAILS = ` ${operator.email.toUpperCase()} , someone-else@example.test`;
});
afterEach(() => {
  delete process.env.PLATFORM_OPERATOR_EMAILS;
});

describe("rating a seller", () => {
  it("is one to five stars, given once, by an owner or admin of the buyer", async () => {
    const id = await engaged(acme, relay);
    const rate = (actor: Actor | null, input: unknown) => rateEngagement(actor, id, input);

    await expect(rate(null, { stars: 5 })).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(rate(acmeMember, { stars: 5 })).rejects.toMatchObject({ code: "forbidden" });
    // Not the seller, and not another buyer: to them the engagement does not exist.
    await expect(rate(relay.owner, { stars: 5 })).rejects.toMatchObject({ code: "not_found" });
    await expect(rate(globex.owner, { stars: 1, comment: PROBLEM })).rejects.toMatchObject({ code: "not_found" });
    for (const stars of [0, 6, 2.5, "five", undefined]) {
      await expect(rate(acme.owner, { stars }), String(stars)).rejects.toMatchObject({ code: "invalid" });
    }

    const { rating, caseOpened } = await rate(acmeAdmin, { stars: "4", comment: "  Found the defect quickly.  " });
    expect(rating).toMatchObject({ stars: 4, comment: "Found the defect quickly.", chainStatus: "platform", chainRef: null });
    expect(rating.sellerProfileId).toBe(relay.id);
    expect(caseOpened).toBeNull();

    await expect(rate(acme.owner, { stars: 1, comment: PROBLEM })).rejects.toMatchObject({ code: "conflict" });
    await expect(
      db.insert(schema.engagementRatings).values({ ...rating, id: randomUUID(), stars: 1 }),
    ).rejects.toThrow();
    await expect(db.update(schema.engagementRatings).set({ stars: 9 }).where(eq(schema.engagementRatings.id, rating.id))).rejects.toThrow();
    expect((await getEngagementFeedback(acme.owner, id)).rating?.stars).toBe(4);
  });

  it("needs something to have been bought", async () => {
    const id = await engaged(acme, relay, { buy: false });
    await expect(rateEngagement(acme.owner, id, { stars: 5 })).rejects.toMatchObject({ code: "conflict" });
    await expect(reportProblem(acme.owner, id, { reason: PROBLEM })).rejects.toMatchObject({ code: "conflict" });
    expect(await getEngagementFeedback(acme.owner, id)).toMatchObject({ rating: null, cases: [] });
    expect((await getEngagementFeedback(acme.owner, id)).rateBlockedBy).toContain("once something has been bought");
  });

  it("sends one or two stars to 905 Finance, and needs the reason", async () => {
    const id = await engaged(acme, relay);
    const error = await rateEngagement(acme.owner, id, { stars: 2, comment: "Bad." }).catch((e) => e);
    expect(error.fieldErrors.comment).toBeDefined();
    const { rating, caseOpened } = await rateEngagement(acme.owner, id, { stars: 2, comment: PROBLEM });
    expect(caseOpened).toMatchObject({ origin: "low_rating", status: "open", reason: PROBLEM, ratingId: rating.id, score: null });
    expect(caseOpened!.requestHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Three stars is a rating, not a complaint.
    const fine = await engaged(acme, relay);
    expect((await rateEngagement(acme.owner, fine, { stars: 3 })).caseOpened).toBeNull();
  });

  it("publishes a document about the rating that names no one and matches its hash", async () => {
    const id = await engaged(acme, relay);
    const { rating } = await rateEngagement(acme.owner, id, { stars: 5, comment: "Private remark about Acme's code." });
    const document = (await getRatingDocument(rating.id))!;
    expect(keccak256(stringToBytes(document))).toBe(rating.feedbackHash);
    expect(JSON.parse(document)).toMatchObject({ stars: 5, value: 100, valueDecimals: 0, tag1: "starred", rating: rating.id });
    for (const secret of ["Private remark", "acme", relay.slug, id, acme.org]) {
      expect(document.toLowerCase(), secret).not.toContain(secret.toLowerCase());
    }
    expect(await getRatingDocument(randomUUID())).toBeNull();
    expect(await getRatingDocument("../etc")).toBeNull();
  });

  it("adds up into a public reputation of counts, with no names and no comments", async () => {
    const fresh = await createSeller("fresh");
    expect(await getSellerReputation(fresh.id)).toEqual({
      ratings: 0,
      averageTenths: null,
      distribution: [0, 0, 0, 0, 0],
      onChain: 0,
      cases: { open: 0, upheld: 0, notUpheld: 0 },
    });
    for (const [buyer, stars] of [[acme, 5], [acme, 4], [globex, 2]] as const) {
      await rateEngagement(buyer.owner, await engaged(buyer, fresh), { stars, comment: PROBLEM });
    }
    const reputation = (await getSellerReputationBySlug(fresh.slug))!;
    expect(reputation).toMatchObject({ ratings: 3, averageTenths: 37, distribution: [0, 1, 0, 1, 1], cases: { open: 1 } });
    expect(JSON.stringify(reputation)).not.toContain("skipped");
    // A listing that is not public has no public reputation.
    await db.update(schema.sellerProfiles).set({ status: "suspended" }).where(eq(schema.sellerProfiles.id, fresh.id));
    expect(await getSellerReputationBySlug(fresh.slug)).toBeNull();
  });
});

describe("a problem put to 905 Finance", () => {
  it("is opened by the buyer, one at a time, and seen by both sides", async () => {
    const id = await engaged(acme, relay);
    await expect(reportProblem(acmeMember, id, { reason: PROBLEM })).rejects.toMatchObject({ code: "forbidden" });
    await expect(reportProblem(relay.owner, id, { reason: PROBLEM })).rejects.toMatchObject({ code: "not_found" });
    await expect(reportProblem(acme.owner, id, { reason: "Bad." })).rejects.toMatchObject({ code: "invalid" });

    const opened = await reportProblem(acmeAdmin, id, { reason: PROBLEM });
    expect(opened).toMatchObject({ origin: "reported", status: "open", ratingId: null });
    await expect(reportProblem(acme.owner, id, { reason: PROBLEM })).rejects.toMatchObject({ code: "conflict" });
    // A low rating while a case is open joins it rather than opening a second.
    expect((await rateEngagement(acme.owner, id, { stars: 1, comment: PROBLEM })).caseOpened).toBeNull();
    await expect(
      db.insert(schema.validationCases).values({ ...opened, id: randomUUID() }),
    ).rejects.toThrow();

    expect((await getEngagementFeedback(acmeMember, id)).cases).toHaveLength(1);
    expect((await getEngagementFeedback(acme.owner, id)).reportBlockedBy).toContain("reviewing");
    const seen = (await listSellerFeedback(relay.owner, relay.org))!;
    expect(seen.cases.map((c) => c.id)).toContain(opened.id);
    // The seller sees what was said, not who said it.
    expect(JSON.stringify(seen)).not.toContain("acme software");
    await expect(listSellerFeedback(acme.owner, relay.org)).rejects.toMatchObject({ code: "forbidden" });
    await expect(getEngagementFeedback(relay.owner, id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("takes one reply from the seller, while it is open", async () => {
    const id = await engaged(acme, relay);
    const opened = await reportProblem(acme.owner, id, { reason: PROBLEM });
    const reply = { response: "The mandate permitted the unit suite only, and that is what was run." };
    // Not the buyer, not another seller, not a stranger.
    for (const other of [acme.owner, ledger.owner, stranger]) {
      await expect(respondToCase(other, opened.id, reply)).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(respondToCase(null, opened.id, reply)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(respondToCase(relay.owner, opened.id, { response: "No." })).rejects.toMatchObject({ code: "invalid" });
    const answered = await respondToCase(relay.owner, opened.id, reply);
    expect(answered.sellerResponse).toBe(reply.response);
    await expect(respondToCase(relay.owner, opened.id, reply)).rejects.toMatchObject({ code: "conflict" });
    expect((await getEngagementFeedback(acme.owner, id)).cases[0].sellerResponse).toBe(reply.response);
  });
});

describe("the 905 Finance validator", () => {
  it("is whoever the deployment names, by their verified sign-in, and nobody else", async () => {
    expect(await isPlatformOperator(operator)).toBe(true);
    for (const other of [acme.owner, relay.owner, stranger, null]) expect(await isPlatformOperator(other)).toBe(false);
    // A user with no address on file can never match, whatever the setting says.
    const [nameless] = await db.insert(schema.users).values({ privyUserId: `test:nameless:${randomUUID()}` }).returning();
    process.env.PLATFORM_OPERATOR_EMAILS = ",, ,@";
    expect(await isPlatformOperator({ userId: nameless.id })).toBe(false);
    delete process.env.PLATFORM_OPERATOR_EMAILS;
    expect(await isPlatformOperator(operator)).toBe(false);
  });

  it("alone sees the queue, and to everyone else it does not exist", async () => {
    const id = await engaged(acme, relay);
    const opened = await reportProblem(acme.owner, id, { reason: PROBLEM });
    for (const other of [acme.owner, relay.owner, stranger]) {
      await expect(listCasesForOperator(other)).rejects.toMatchObject({ code: "not_found" });
      await expect(getCaseForOperator(other, opened.id)).rejects.toMatchObject({ code: "not_found" });
      await expect(decideCase(other, opened.id, VERDICT)).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(listCasesForOperator(null)).rejects.toMatchObject({ code: "unauthenticated" });

    const queue = await listCasesForOperator(operator);
    expect(queue[0]).toMatchObject({ status: "open" });
    expect(queue.find((entry) => entry.id === opened.id)).toMatchObject({ sellerName: "relay agents", buyerName: "acme software" });
    const detail = await getCaseForOperator(operator, opened.id);
    expect(detail).toMatchObject({ reason: PROBLEM, conflicted: false, sellerResponse: null });
    // The evidence is the platform's record of the tests, not either side's account of them.
    expect(detail.evidence).toHaveLength(1);
    expect(detail.evidence[0]).toMatchObject({ capability: "unit_testing", status: "queued", outcome: null });
    // It is given what it needs to decide, and nothing about money or credentials.
    expect(Object.keys(detail)).not.toContain("wallet");
    expect(JSON.stringify(detail)).not.toMatch(/sim-wallet|demo-payment|providerRef|custody/);
  });

  it("gives one verdict, with a score and a reason, that both sides then read", async () => {
    const id = await engaged(acme, relay);
    const { caseOpened } = await rateEngagement(acme.owner, id, { stars: 1, comment: PROBLEM });
    const decide = (input: Record<string, unknown>) => decideCase(operator, caseOpened!.id, { ...VERDICT, ...input });

    await expect(decide({ confirmed: false })).rejects.toMatchObject({ code: "invalid" });
    await expect(decide({ note: "Short." })).rejects.toMatchObject({ code: "invalid" });
    await expect(decide({ score: 101 })).rejects.toMatchObject({ code: "invalid" });
    await expect(decide({ verdict: "maybe" })).rejects.toMatchObject({ code: "invalid" });
    // The score has to agree with the verdict.
    await expect(decide({ verdict: "upheld", score: 80 })).rejects.toMatchObject({ code: "invalid" });
    await expect(decide({ verdict: "not_upheld", score: 20 })).rejects.toMatchObject({ code: "invalid" });

    const decided = await decide({});
    expect(decided).toMatchObject({ status: "upheld", score: 30, decidedBy: operator.userId });
    expect(decided.decidedAt).toBeInstanceOf(Date);
    await expect(decide({ verdict: "not_upheld", score: 90 })).rejects.toMatchObject({ code: "conflict" });
    await expect(respondToCase(relay.owner, caseOpened!.id, { response: "Too late to reply to this." })).rejects.toMatchObject({ code: "conflict" });
    // The database holds a verdict to the same shape.
    await expect(db.update(schema.validationCases).set({ score: null }).where(eq(schema.validationCases.id, decided.id))).rejects.toThrow();
    await expect(db.update(schema.validationCases).set({ score: 400 }).where(eq(schema.validationCases.id, decided.id))).rejects.toThrow();

    expect((await getEngagementFeedback(acme.owner, id)).cases[0]).toMatchObject({ status: "upheld", verdictNote: VERDICT.note });
    expect((await listSellerFeedback(relay.owner, relay.org))!.cases.find((c) => c.id === decided.id)).toMatchObject({ score: 30 });
    expect((await getSellerReputation(relay.id)).cases.upheld).toBeGreaterThanOrEqual(1);
    for (const [owner, org] of [[acme.owner, acme.org], [relay.owner, relay.org]] as const) {
      expect((await listAuditEvents(owner, org)).map((e) => e.action)).toContain("validation.decided");
    }
    // A new problem can be raised once the first is decided.
    expect((await reportProblem(acme.owner, id, { reason: PROBLEM })).status).toBe("open");
  });

  it("cannot decide a case it is on either side of", async () => {
    const id = await engaged(acme, relay);
    const opened = await reportProblem(acme.owner, id, { reason: PROBLEM });
    const conflicted = await createUser(db, "conflicted");
    process.env.PLATFORM_OPERATOR_EMAILS = `${operator.email},${conflicted.email}`;

    await addMember(db, acme.org, conflicted.userId, "member");
    expect((await getCaseForOperator(conflicted, opened.id)).conflicted).toBe(true);
    await expect(decideCase(conflicted, opened.id, VERDICT)).rejects.toMatchObject({ code: "forbidden" });

    const sellerSide = await createUser(db, "seller-side");
    process.env.PLATFORM_OPERATOR_EMAILS = `${operator.email},${sellerSide.email}`;
    await addMember(db, relay.org, sellerSide.userId, "member");
    await expect(decideCase(sellerSide, opened.id, VERDICT)).rejects.toMatchObject({ code: "forbidden" });

    const [stillOpen] = await db.select().from(schema.validationCases).where(eq(schema.validationCases.id, opened.id));
    expect(stillOpen.status).toBe("open");
    expect((await decideCase(operator, opened.id, { ...VERDICT, verdict: "not_upheld", score: 85 })).status).toBe("not_upheld");
  });
});

describe("registration documents", () => {
  it("are served for active listings, and name an agent only once one is linked", async () => {
    const document = (await sellerRegistrationDocument(relay.slug))!;
    expect(document).toMatchObject({ name: "relay agents", active: true, registrations: [] });
    expect((document.services as Array<{ endpoint: string }>)[0].endpoint).toMatch(new RegExp(`/agents/${relay.slug}$`));
    expect(JSON.stringify(document)).not.toMatch(/endpoint\.example|organizationId|@/);
    const draft = await createUser(db, "draft-owner");
    const ws = await completeOnboarding(draft, { displayName: "draft owner", organizationName: "draft co", accountType: "business", roles: "seller" });
    expect(await sellerRegistrationDocument(ws.sellerProfile!.slug)).toBeNull();
    expect(await sellerRegistrationDocument("no-such-listing")).toBeNull();
  });

  it("for a buying agent are found only by its own unguessable address", async () => {
    const [profile] = await db.select().from(schema.buyerProfiles).where(eq(schema.buyerProfiles.organizationId, acme.org));
    expect(await buyerRegistrationDocument(profile.id)).toMatchObject({ name: "acme software buying agent", registrations: [] });
    expect(await buyerRegistrationDocument(randomUUID())).toBeNull();
    expect(await buyerRegistrationDocument(acme.org)).toBeNull();
    expect(await buyerRegistrationDocument("acme-software")).toBeNull();
  });

  it("count as an agent's own only at this application's address, over https, with nothing appended", () => {
    const path = "/agents/relay/registration.json";
    expect(registrationIsHostedAt(`https://905finance.com${path}`, path)).toBe(true);
    expect(registrationIsHostedAt(`https://www.905finance.com${path}`, path)).toBe(true);
    for (const uri of [
      `http://905finance.com${path}`,
      `https://905finance.com.evil.example${path}`,
      `https://evil.example/905finance.com${path}`,
      `https://905finance.com${path}?x=1`,
      `https://905finance.com/agents/other/registration.json`,
      `https://905finance.com${path}/..`,
      "ipfs://905finance.com/agents/relay/registration.json",
      "",
      "not a url",
    ]) {
      expect(registrationIsHostedAt(uri, path), uri).toBe(false);
    }
  });
});
