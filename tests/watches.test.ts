import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { keccak256, stringToBytes } from "viem";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import {
  FINAL_GRACE_MS,
  describeWatch,
  findingIdentity,
  offeringTerms,
  readingClosesAt,
  readingDueAt,
  readingDueNow,
  readingEveryHours,
  readingsPlanned,
  summarizeWatch,
  watchEndsAt,
  type WatchFinding,
  type WatchReading,
} from "@/lib/watch";
import { completeOnboarding } from "@/server/accounts";
import type { AgentBrain } from "@/server/agent/brain";
import { runAgent } from "@/server/agent/runtime";
import { DemoSellerTransport, setSellerTransportResolver } from "@/server/agent/transport";
import type { Actor } from "@/server/authz";
import { completeEngagement } from "@/server/closure";
import { getEngagementActivity } from "@/server/engagement-activity";
import {
  authorizeEngagement,
  authorizeFunding,
  createEngagement,
  provisionEngagementWallet,
  saveMandateDraft,
} from "@/server/engagements";
import { getPublicSellerBySlug } from "@/server/marketplace";
import { createProject } from "@/server/projects";
import { runProofs } from "@/server/proofs";
import { answerAsSampleSeller } from "@/server/seller-agent/service";
import { createOffering, saveSellerEndpoint, updateSellerListing } from "@/server/sellers";
import {
  claimTestingJob,
  requeueTestingJob,
  setRepositoryProbe,
  submitTestingResult,
  workerCheckIn,
} from "@/server/testing/jobs";
import { getTestingReport, listTestingJobs } from "@/server/testing/reports";
import { MISSED_READING, advanceWatches, getWatch, listEngagementWatches, listWatches } from "@/server/testing/watches";
import { depositSimulatedFunds } from "@/server/wallets";
import {
  createUser,
  fixtureProject,
  markSample,
  platformActivate,
  registerWorker,
  useTestDatabase,
  validEndpoint,
  validListing,
} from "./support/db";

/**
 * Milestone 13: work a seller does over a period. A watch is the same
 * read-only look taken on a schedule, with a first look straight away and
 * one report at the end.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// The arithmetic, with no database
// ---------------------------------------------------------------------------

const header = (name: string, overrides: Partial<WatchFinding> = {}): WatchFinding => ({
  title: `No ${name} header`,
  severity: "medium",
  category: "configuration",
  location: name.toLowerCase(),
  evidence: "The header was not sent.",
  ...overrides,
});

const taken = (reading: number, findings: WatchFinding[]): WatchReading => ({ reading, state: "taken", findings });

describe("a watch's schedule", () => {
  it("reads a one-day watch every six hours and a longer one once a day", () => {
    expect([1, 5, 10].map(readingEveryHours)).toEqual([6, 24, 24]);
    // The first look and the reading at the very end are both counted.
    expect([1, 5, 10].map(readingsPlanned)).toEqual([5, 6, 11]);
  });

  it("knows which reading is due, and until when each may still be taken", () => {
    const startedAt = new Date("2026-11-14T09:00:00Z");
    const watch = { startedAt, everyHours: 24, readingsPlanned: 6 };
    expect(readingDueAt(watch, 2).toISOString()).toBe("2026-11-16T09:00:00.000Z");
    expect(watchEndsAt(watch).toISOString()).toBe("2026-11-19T09:00:00.000Z");
    const at = (hours: number) => new Date(startedAt.getTime() + hours * HOUR);
    expect([0, 23.9, 24, 71, 120, 500].map((hours) => readingDueNow(watch, at(hours)))).toEqual([0, 0, 1, 2, 5, 5]);
    expect(readingDueNow(watch, at(-5))).toBe(0);
    // A reading may be taken until the next is due; the last has a grace period and no more.
    expect(readingClosesAt(watch, 0)).toEqual(readingDueAt(watch, 1));
    expect(readingClosesAt(watch, 5).getTime()).toBe(watchEndsAt(watch).getTime() + FINAL_GRACE_MS);
  });

  it("words a price by what it buys", () => {
    expect(offeringTerms({ billingUnit: "per_run", periodDays: null })).toBe("per run");
    expect(offeringTerms({ billingUnit: "per_run", periodDays: 1 })).toBe("for 1 day");
    expect(offeringTerms({ billingUnit: "per_run", periodDays: 10 })).toBe("for 10 days");
  });
});

describe("comparing a watch's readings", () => {
  it("treats a finding as the same one when only its line number or a count moved", () => {
    const code = (startLine: number) => ({
      file: "src/run.ts",
      startLine,
      highlightStart: startLine + 1,
      highlightEnd: startLine + 1,
      lines: ["function run(input) {", "  return eval(input);", "}"],
    });
    const before: WatchFinding = { title: "Code injection", severity: "high", category: "security", location: "src/run.ts:12", evidence: "", code: code(11) };
    const moved: WatchFinding = { ...before, location: "src/run.ts:40", code: code(39) };
    expect(findingIdentity(moved)).toBe(findingIdentity(before));
    // Different code on the flagged line is a different finding.
    const other = { ...before, code: { ...code(11), lines: ["function run(input) {", "  return eval(other);", "}"] } };
    expect(findingIdentity(other)).not.toBe(findingIdentity(before));
    // A count ticking down is the same finding a day later.
    const certificate = (days: number): WatchFinding => ({ title: `The certificate expires in ${days} days`, severity: "medium", category: "configuration", location: "www.example.com", evidence: "Valid until Dec 1" });
    expect(findingIdentity(certificate(12))).toBe(findingIdentity(certificate(11)));
    expect(findingIdentity(header("Referrer-Policy"))).not.toBe(findingIdentity(header("Permissions-Policy")));
  });

  it("sorts findings into stayed, appeared, resolved, and came and went", () => {
    const summary = summarizeWatch(4, [
      taken(0, [header("A"), header("B")]),
      taken(1, [header("A"), header("B"), header("C"), header("D")]),
      { reading: 2, state: "missed", findings: [] },
      taken(3, [header("A"), header("D", { severity: "high" })]),
    ]);
    expect(summary).toMatchObject({ planned: 4, taken: 3, missed: 1, unreadable: 0, comparable: true, first: 0, last: 3 });
    expect(summary.counts).toEqual({ throughout: 1, appeared: 1, resolved: 1, came_and_went: 1, changed: 0 });
    const byTitle = Object.fromEntries(summary.tracked.map((entry) => [entry.title, entry]));
    expect(byTitle["No A header"]).toMatchObject({ status: "throughout", seenIn: [0, 1, 3] });
    expect(byTitle["No B header"]).toMatchObject({ status: "resolved", seenIn: [0, 1] });
    expect(byTitle["No C header"]).toMatchObject({ status: "came_and_went", seenIn: [1] });
    // A finding carries the severity it had when last seen.
    expect(byTitle["No D header"]).toMatchObject({ status: "appeared", seenIn: [1, 3], severity: "high" });
    // What appeared is listed first, since it is what the buyer most needs to see.
    expect(summary.tracked[0].title).toBe("No D header");
    expect(summary.deltas).toEqual([
      { reading: 1, appeared: 2, gone: 0, changed: 0 },
      { reading: 3, appeared: 0, gone: 2, changed: 0 },
    ]);
  });

  it("notices when what was read about a finding changed, and shows both readings of it", () => {
    const proxy = (implementation: string): WatchFinding => ({
      title: "Its logic can be replaced by a single account",
      severity: "medium",
      category: "observation",
      location: "0x54B8d8E2455946f2A5B8982283f2359812e815ce",
      evidence: `EIP-1967 implementation slot: ${implementation}`,
    });
    const summary = summarizeWatch(3, [taken(0, [proxy("0xaaa")]), taken(1, [proxy("0xaaa")]), taken(2, [proxy("0xbbb")])]);
    expect(summary.counts).toMatchObject({ throughout: 1, changed: 1 });
    expect(summary.tracked[0].changes).toEqual([
      { reading: 2, before: "EIP-1967 implementation slot: 0xaaa", after: "EIP-1967 implementation slot: 0xbbb" },
    ]);
    expect(summary.deltas[1]).toEqual({ reading: 2, appeared: 0, gone: 0, changed: 1 });
    // A tool's own wording about source code is not a quote of the thing, so a reworded message is not a change.
    const lint = (evidence: string): WatchFinding => ({ title: "Authorization by tx.origin", severity: "high", category: "security", location: "Gate.sol:7", evidence });
    expect(summarizeWatch(2, [taken(0, [lint("one")]), taken(1, [lint("two")])]).counts.changed).toBe(0);
  });

  it("compares nothing when fewer than two readings were taken, and never counts one that was not", () => {
    const one = summarizeWatch(6, [
      taken(0, [header("A")]),
      { reading: 1, state: "missed", findings: [] },
      { reading: 2, state: "unreadable", findings: [header("ignored")] },
      { reading: 3, state: "scheduled", findings: [] },
    ]);
    expect(one).toMatchObject({ taken: 1, missed: 1, unreadable: 1, comparable: false, first: 0, last: 0 });
    expect(one.tracked.map((entry) => entry.title)).toEqual(["No A header"]);
    expect(describeWatch(5, one)).toBe(
      "5-day watch: 1 of 6 readings were taken (1 missed, 1 could not be read). 1 finding in the one reading taken, with nothing to compare it with.",
    );
    const none = summarizeWatch(5, [{ reading: 0, state: "unreadable", findings: [] }]);
    expect(none).toMatchObject({ taken: 0, comparable: false, first: null, last: null, tracked: [] });
    expect(describeWatch(1, none)).toBe("1-day watch: 0 of 5 readings were taken (1 could not be read). There is nothing to report.");
  });

  it("says how a finished watch went in a sentence", () => {
    const summary = summarizeWatch(3, [
      taken(0, [header("A"), header("B")]),
      taken(1, [header("A"), header("B"), header("C")]),
      taken(2, [header("A"), header("C")]),
    ]);
    expect(describeWatch(10, summary)).toBe(
      "10-day watch: 3 of 3 readings were taken. 1 finding was there from start to end, 1 appeared, 1 was resolved.",
    );
  });
});

// ---------------------------------------------------------------------------
// Buying, scheduling and reporting
// ---------------------------------------------------------------------------

let db: Db;
let close: () => Promise<void>;

const PAIRS = ["github:security_scan", "files:security_scan", "website:website_check", "contracts:contract_check"];
const REGISTRY = "0x54B8d8E2455946f2A5B8982283f2359812e815ce";
const own = { sourceType: "repository", hasWeb3: true, testingAuthorized: true } as const;

let buyer: Actor;
let org: string;
let seller: { slug: string; id: string; offering: Record<string, string> };

async function engage(projectId: string): Promise<string> {
  const engagement = await createEngagement(buyer, org, { sellerSlug: seller.slug, projectId });
  await saveMandateDraft(buyer, engagement.id, {
    rail: "goat",
    totalBudget: "100",
    perTransactionLimit: "50",
    offeringIds: Object.values(seller.offering),
    scope: "Watch it and report what changes.",
    expiresInDays: 30,
  });
  await authorizeEngagement(buyer, engagement.id, { confirmed: true });
  await provisionEngagementWallet(buyer, engagement.id);
  await authorizeFunding(buyer, engagement.id, { amount: "100", idempotencyKey: randomUUID(), confirmed: true });
  return engagement.id;
}

function buying(keys: string[]): AgentBrain {
  const queue = [...keys];
  return {
    name: "test",
    async next() {
      const key = queue.shift();
      return key
        ? { tool: "purchase_service", input: { offeringId: seller.offering[key], reason: "test" } }
        : { tool: "finish", input: { summary: "Done." } };
    },
  };
}

const buy = (engagementId: string, keys: string[]) => runAgent(buyer, engagementId, { runKey: randomUUID() }, buying(keys));
const jobsOf = (engagementId: string) =>
  db.select().from(schema.testingJobs).where(eq(schema.testingJobs.engagementId, engagementId)).orderBy(schema.testingJobs.sequence);
const purchaseOf = async (engagementId: string) =>
  (await db.select().from(schema.purchases).where(eq(schema.purchases.engagementId, engagementId)))[0];
const watchOf = async (engagementId: string) =>
  (await db.select().from(schema.watches).where(eq(schema.watches.engagementId, engagementId)))[0];
const claim = (workerId = "reader") =>
  claimTestingJob({ workerId, tools: { eslint: "x", webcheck: "1", chaincheck: "1" }, supports: PAIRS });

/** Buy one watch on a project, expecting it to be sold. */
async function watching(projectId: string, key: string) {
  const engagementId = await engage(projectId);
  const result = await buy(engagementId, [key]);
  expect(result.run.purchasesCompleted, result.run.summary ?? "").toBe(1);
  return { engagementId, watch: await watchOf(engagementId) };
}

/** Try to buy a watch, expecting the seller to decline before any payment. */
async function declined(projectId: string, key: string) {
  const engagementId = await engage(projectId);
  const result = await buy(engagementId, [key]);
  expect(result.run.purchasesCompleted).toBe(0);
  expect(await purchaseOf(engagementId)).toBeUndefined();
  expect(await watchOf(engagementId)).toBeUndefined();
  return result.run.summary ?? "";
}

/** Let time pass for one watch, by moving its start back. */
async function later(watchId: string, ms: number) {
  const [watch] = await db.select().from(schema.watches).where(eq(schema.watches.id, watchId));
  await db
    .update(schema.watches)
    .set({ startedAt: new Date(watch.startedAt.getTime() - ms), endsAt: new Date(watch.endsAt.getTime() - ms) })
    .where(eq(schema.watches.id, watchId));
}

const websiteFinding = (name: string, overrides: Record<string, unknown> = {}) => ({
  title: `No ${name} header`,
  severity: "medium",
  category: "configuration",
  location: name.toLowerCase(),
  evidence: "The header was not sent.",
  recommendation: "Send one.",
  ...overrides,
});

const result = (tool: string, findings: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) => ({
  outcome: findings.some((finding) => finding.severity !== "low" && finding.severity !== "info") ? "failed" : "passed",
  tool,
  toolVersion: "1",
  command: "reading",
  exitCode: null,
  durationMs: 300,
  log: "Read what was shared.",
  findings,
  ...overrides,
});

/** A worker checks in, is handed the reading that is due, and hands in what it found. */
async function take(findings: Array<Record<string, unknown>>, tool = "webcheck", overrides: Record<string, unknown> = {}) {
  const job = await claim();
  expect(job, "a reading should have been queued").not.toBeNull();
  await submitTestingResult(job!.id, { workerId: "reader", result: result(tool, findings, overrides) });
  return job!;
}

beforeAll(async () => {
  ({ db, close } = await useTestDatabase());
  const sellerOwner = await createUser(db, "vigil-owner");
  const sellerWs = await completeOnboarding(sellerOwner, {
    displayName: "Vigil owner",
    organizationName: "Vigil agents",
    accountType: "business",
    roles: "seller",
  });
  const sellerOrg = sellerWs.organization.id;
  await updateSellerListing(sellerOwner, sellerOrg, {
    ...validListing,
    displayName: "Vigil agents",
    capabilities: ["website_check", "contract_check", "security_scan"],
    intendedRails: ["goat"],
  });
  await saveSellerEndpoint(sellerOwner, sellerOrg, validEndpoint);
  const offer = async (key: string, capability: string, periodDays: number | null) =>
    [
      key,
      (
        await createOffering(sellerOwner, sellerOrg, {
          name: key,
          description: "",
          capability,
          billingUnit: "per_run",
          priceMinor: 2000,
          periodDays,
        })
      ).id,
    ] as const;
  const offering = Object.fromEntries([
    await offer("website-1", "website_check", 1),
    await offer("website-5", "website_check", 5),
    await offer("website-once", "website_check", null),
    await offer("contracts-5", "contract_check", 5),
    await offer("scan-5", "security_scan", 5),
  ]);
  // A period that is not one of the three offered is refused.
  await expect(
    createOffering(sellerOwner, sellerOrg, { name: "Odd", description: "", capability: "website_check", billingUnit: "per_run", priceMinor: 100, periodDays: 3 }),
  ).rejects.toMatchObject({ code: "invalid" });
  await platformActivate(db, sellerWs.sellerProfile!.slug);
  await markSample(db, sellerWs.sellerProfile!.slug);
  seller = { slug: sellerWs.sellerProfile!.slug, id: sellerWs.sellerProfile!.id, offering };

  buyer = await createUser(db, "quay-owner");
  const buyerWs = await completeOnboarding(buyer, {
    displayName: "Quay owner",
    organizationName: "Quay software",
    accountType: "business",
    roles: "buyer",
  });
  org = buyerWs.organization.id;
  await depositSimulatedFunds(buyer, org, { rail: "goat", amount: "1000000" });
});
afterAll(async () => close());

beforeEach(async () => {
  setRepositoryProbe(async () => ({ exists: true, languages: ["TypeScript"] }));
  setSellerTransportResolver((context) => new DemoSellerTransport(context));
  // Each test starts with no work waiting and no watch still running.
  await db
    .update(schema.watches)
    .set({ status: "failed", finishedAt: new Date(), summary: "left over from another test" })
    .where(eq(schema.watches.status, "watching"));
  for (const status of ["queued", "running"] as const) {
    await db
      .update(schema.testingJobs)
      .set({ status: "failed", failureReason: "left over from another test" })
      .where(eq(schema.testingJobs.status, status));
  }
  await db.delete(schema.testingWorkers);
  await registerWorker(db, PAIRS);
});
afterEach(() => {
  setRepositoryProbe(undefined);
  setSellerTransportResolver(undefined);
});

describe("buying work over a period", () => {
  it("starts a watch, and queues its first reading straight away as the first look", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Watched site", applicationUrl: "https://www.example.com" });
    const { engagementId, watch } = await watching(project.id, "website-5");
    expect(watch).toMatchObject({
      capability: "website_check",
      fixtureKey: "website",
      source: { kind: "website", url: "https://www.example.com" },
      periodDays: 5,
      everyHours: 24,
      readingsPlanned: 6,
      status: "watching",
      finishedAt: null,
    });
    expect(watch.endsAt.getTime() - watch.startedAt.getTime()).toBe(5 * DAY);
    // Paid once, up front. It is delivered by the period report, not before.
    const purchase = await purchaseOf(engagementId);
    expect(purchase).toMatchObject({ status: "paid", delivery: null });
    expect(purchase.amountUnits).toBe(2000n);
    const jobs = await jobsOf(engagementId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ watchId: watch.id, reading: 0, status: "queued", capability: "website_check" });
    // A worker is handed a reading exactly as it is handed any first look: nothing says it is part of a watch.
    expect(await claim()).toEqual({
      id: jobs[0].id,
      fixtureKey: "website",
      capability: "website_check",
      source: { kind: "website", url: "https://www.example.com" },
    });
  });

  it("is sold in the lengths a seller lists, and shown as such in the marketplace", async () => {
    const listing = await getPublicSellerBySlug(seller.slug);
    expect(listing!.periods).toEqual([1, 5]);
    expect(listing!.offerings.find((offering) => offering.name === "website-once")!.periodDays).toBeNull();
    const project = await createProject(buyer, org, { ...own, name: "One day", applicationUrl: "https://www.example.com" });
    const { watch } = await watching(project.id, "website-1");
    expect(watch).toMatchObject({ periodDays: 1, everyHours: 6, readingsPlanned: 5 });
    expect(watch.endsAt.getTime() - watch.startedAt.getTime()).toBe(DAY);
  });

  it("is declined, before any payment, where there is nothing that could change", async () => {
    // A bundled project never changes.
    const bundled = await createProject(buyer, org, { ...fixtureProject, name: "Bundled" });
    expect(await declined(bundled.id, "website-5")).toContain("A bundled project never changes");
    // Files shared once never change either; the single scan is still sold for them.
    const files = await createProject(buyer, org, { ...own, name: "Files", files: [{ name: "api.ts", content: "export const a = 1;\n" }] });
    expect(await declined(files.id, "scan-5")).toContain("Shared files do not change");
    // Nothing shared of that kind at all.
    expect(await declined(files.id, "website-5")).toContain("no public website address");
    expect(await declined(files.id, "contracts-5")).toContain("shares no contract addresses");
    // A repository can change, so it can be watched.
    const repository = await createProject(buyer, org, { ...own, name: "Repository", repositoryUrl: "https://github.com/example/api" });
    const { watch } = await watching(repository.id, "scan-5");
    expect(watch).toMatchObject({ fixtureKey: "github", source: { kind: "github", owner: "example", repo: "api" } });
  });

  it("is not sold twice over for the same thing at the same time", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Once only", applicationUrl: "https://www.example.com" });
    const { watch } = await watching(project.id, "website-5");
    const reason = await declined(project.id, "website-1");
    expect(reason).toContain("already has this watch running");
    expect(reason).toContain(watch.endsAt.toISOString().slice(0, 10));
    // A single first look of the same site is a different thing, and is still sold.
    const engagementId = await engage(project.id);
    expect((await buy(engagementId, ["website-once"])).run.purchasesCompleted).toBe(1);
    expect(await watchOf(engagementId)).toBeUndefined();
  });

  it("is not sold while no worker can take the readings", async () => {
    await db.delete(schema.testingWorkers);
    const project = await createProject(buyer, org, { ...own, name: "Nobody home", applicationUrl: "https://www.example.com" });
    expect(await declined(project.id, "website-5")).toContain("No testing worker is online");
  });
});

describe("taking a watch's readings", () => {
  it("keeps the purchase undelivered after the first look, which is a full report of its own", async () => {
    const project = await createProject(buyer, org, { ...own, name: "First look", applicationUrl: "https://www.example.com" });
    const { engagementId, watch } = await watching(project.id, "website-5");
    const first = await take([websiteFinding("Content-Security-Policy"), websiteFinding("Permissions-Policy", { severity: "info" })]);

    expect(await purchaseOf(engagementId)).toMatchObject({ status: "paid", delivery: null });
    expect((await watchOf(engagementId)).status).toBe("watching");
    const report = await getTestingReport(buyer, first.id);
    expect(report.watch).toEqual({ id: watch.id, reading: 0, readingsPlanned: 6, periodDays: 5 });
    expect(report.findings).toHaveLength(2);
    expect(report.result!.summary).toBe("The website check reported 2 findings: 1 medium, 1 informational.");
    const notes = await db
      .select()
      .from(schema.agentMessages)
      .where(and(eq(schema.agentMessages.engagementId, engagementId), eq(schema.agentMessages.kind, "reading_taken")));
    expect(notes).toHaveLength(1);
    expect(notes[0].body.message).toBe(
      "Reading 1 of 6 of the 5-day watch, the first look: The website check reported 2 findings: 1 medium, 1 informational.",
    );
    // The first look has its own proof, like any report.
    await runProofs();
    const proofs = await db.select().from(schema.proofRecords).where(eq(schema.proofRecords.entityId, first.id));
    expect(proofs.map((proof) => proof.kind)).toEqual(["report"]);
  });

  it("queues each later reading when it comes due, and not before", async () => {
    const project = await createProject(buyer, org, { ...own, name: "On schedule", applicationUrl: "https://www.example.com" });
    const { engagementId, watch } = await watching(project.id, "website-5");
    await take([websiteFinding("A")]);
    // Nothing is due yet, however often a worker asks.
    expect(await claim()).toBeNull();
    expect(await claim()).toBeNull();
    await later(watch.id, 23 * HOUR);
    expect(await claim()).toBeNull();
    expect(await jobsOf(engagementId)).toHaveLength(1);

    await later(watch.id, 1 * HOUR);
    const second = await take([websiteFinding("A")]);
    const jobs = await jobsOf(engagementId);
    expect(jobs.map((job) => [job.reading, job.status])).toEqual([
      [0, "completed"],
      [1, "completed"],
    ]);
    expect(jobs[1]).toMatchObject({ id: second.id, purchaseId: jobs[0].purchaseId, watchId: watch.id, source: watch.source });
    // The same reading is never queued twice.
    expect(await claim()).toBeNull();
    await advanceWatches();
    expect(await jobsOf(engagementId)).toHaveLength(2);
    await expect(
      db.insert(schema.testingJobs).values({ ...jobs[1], id: undefined, sequence: undefined } as never),
    ).rejects.toThrow();
  });

  it("records a reading nobody took in time as missed, and takes the one that is due instead", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Gaps", applicationUrl: "https://www.example.com" });
    const { engagementId, watch } = await watching(project.id, "website-5");
    await take([websiteFinding("A")]);

    // Reading 2 comes due and is queued, but no worker takes it for a day.
    await later(watch.id, DAY);
    await advanceWatches();
    expect((await jobsOf(engagementId)).map((job) => [job.reading, job.status])).toEqual([
      [0, "completed"],
      [1, "queued"],
    ]);
    // Two more days pass with nobody about at all. Then a worker returns.
    await later(watch.id, 2 * DAY);
    const job = await claim();
    const jobs = await jobsOf(engagementId);
    expect(jobs.map((entry) => [entry.reading, entry.status])).toEqual([
      [0, "completed"],
      [1, "failed"],
      [3, "running"],
    ]);
    expect(jobs[1].failureReason).toBe(MISSED_READING);
    expect(job!.id).toBe(jobs[2].id);
    await submitTestingResult(job!.id, { workerId: "reader", result: result("webcheck", [websiteFinding("A")]) });

    const detail = await getWatch(buyer, watch.id);
    expect(detail.readings.map((reading) => reading.state)).toEqual(["taken", "missed", "missed", "taken", "scheduled", "scheduled"]);
    expect(detail.readings[1].note).toBe(MISSED_READING);
    expect(detail.readings[2]).toMatchObject({ jobId: null, note: MISSED_READING });
    expect(detail.report).toMatchObject({ taken: 2, missed: 2, comparable: true });
    // A missed reading is not taken again later.
    await expect(requeueTestingJob(buyer, jobs[1].id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("records a reading the tool could not finish, and carries on", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Down for a day", applicationUrl: "https://www.example.com" });
    const { engagementId, watch } = await watching(project.id, "website-5");
    await take([websiteFinding("A")]);
    await later(watch.id, DAY);
    const down = await take([], "none", { outcome: "error", error: "www.example.com did not answer." });

    expect((await watchOf(engagementId)).status).toBe("watching");
    const detail = await getWatch(buyer, watch.id);
    expect(detail.readings[1]).toMatchObject({ state: "unreadable", jobId: down.id, note: "www.example.com did not answer." });
    expect(detail.report).toMatchObject({ taken: 1, unreadable: 1, comparable: false });
    await later(watch.id, DAY);
    await take([websiteFinding("A")]);
    expect((await getWatch(buyer, watch.id)).report).toMatchObject({ taken: 2, unreadable: 1, comparable: true });
  });

  it("carries on after its engagement ends, since it is already paid for", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Outlives", applicationUrl: "https://www.example.com" });
    const { engagementId, watch } = await watching(project.id, "website-1");
    await take([websiteFinding("A")]);
    await completeEngagement(buyer, engagementId);
    await later(watch.id, 6 * HOUR);
    await take([websiteFinding("A")]);
    expect((await getWatch(buyer, watch.id)).readingsTaken).toBe(2);
  });
});

describe("a watch's period report", () => {
  it("is written when the last reading comes in, and delivers the purchase", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Full period", applicationUrl: "https://www.example.com" });
    const { engagementId, watch } = await watching(project.id, "website-1");
    const a = websiteFinding("Content-Security-Policy");
    const b = websiteFinding("Referrer-Policy", { severity: "low" });
    const c = websiteFinding("Strict-Transport-Security");
    const plan = [[a, b], [a, b], [a, b, c], [a, c], [a, c]];
    const jobs: string[] = [];
    for (const [index, findings] of plan.entries()) {
      if (index > 0) await later(watch.id, 6 * HOUR);
      expect((await watchOf(engagementId)).status).toBe("watching");
      jobs.push((await take(findings)).id);
    }

    const finished = await watchOf(engagementId);
    const sentence = "1-day watch: 5 of 5 readings were taken. 1 finding was there from start to end, 1 appeared, 1 was resolved.";
    expect(finished).toMatchObject({ status: "reported", summary: sentence });
    expect(finished.finishedAt).not.toBeNull();
    expect(await purchaseOf(engagementId)).toMatchObject({
      status: "delivered",
      delivery: { kind: "period_report", watchId: watch.id, summary: sentence },
    });
    const notes = await db
      .select()
      .from(schema.agentMessages)
      .where(and(eq(schema.agentMessages.engagementId, engagementId), eq(schema.agentMessages.kind, "watch_reported")));
    expect(notes.map((note) => note.body.message)).toEqual([sentence]);

    const detail = await getWatch(buyer, watch.id);
    expect(detail.readings.map((reading) => [reading.state, reading.jobId])).toEqual(jobs.map((id) => ["taken", id]));
    expect(detail.report.tracked.map((entry) => [entry.title, entry.status, entry.seenIn])).toEqual([
      ["No Strict-Transport-Security header", "appeared", [2, 3, 4]],
      ["No Content-Security-Policy header", "throughout", [0, 1, 2, 3, 4]],
      ["No Referrer-Policy header", "resolved", [0, 1, 2]],
    ]);
    // Nothing more is queued for a watch that has finished.
    await later(watch.id, 5 * DAY);
    expect(await claim()).toBeNull();
    expect(await jobsOf(engagementId)).toHaveLength(5);
    // The engagement shows the purchase once, not once per reading.
    const activity = await getEngagementActivity(buyer, engagementId);
    expect(activity.purchases).toHaveLength(1);
    expect(activity.purchases[0]).toMatchObject({
      status: "delivered",
      deliverySummary: sentence,
      job: { id: jobs[0] },
      watch: { id: watch.id, status: "reported", periodDays: 1, readingsPlanned: 5, summary: sentence },
    });
    // Each reading is its own line among the reports, marked as part of the watch.
    const lines = (await listTestingJobs(buyer, org)).filter((line) => line.watch?.id === watch.id);
    expect(lines.map((line) => line.watch!.reading).sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("is fingerprinted for GOAT, tied to the proof of every reading it was made from", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Proven", contractAddresses: REGISTRY });
    const { watch } = await watching(project.id, "contracts-5");
    const proxy = (implementation: string) => ({
      title: "Its logic can be replaced by a single account",
      severity: "medium",
      category: "observation",
      location: REGISTRY,
      evidence: `EIP-1967 implementation slot: ${implementation}`,
      recommendation: "Use a multi-signature wallet.",
    });
    const jobs: string[] = [];
    jobs.push((await take([proxy("0xaaa")], "chaincheck")).id);
    // Nothing is fingerprinted as a period report while the watch is still running.
    await runProofs();
    expect(
      await db.select().from(schema.proofRecords).where(and(eq(schema.proofRecords.kind, "period"), eq(schema.proofRecords.entityId, watch.id))),
    ).toEqual([]);
    for (const implementation of ["0xaaa", "0xbbb", "0xbbb", "0xbbb", "0xbbb"]) {
      await later(watch.id, DAY);
      jobs.push((await take([proxy(implementation)], "chaincheck")).id);
    }

    const detail = await getWatch(buyer, watch.id);
    expect(detail.status).toBe("reported");
    expect(detail.summary).toBe(
      "5-day watch: 6 of 6 readings were taken. 1 finding was there from start to end, 0 appeared, 0 were resolved, 1 changed in what was read.",
    );
    expect(detail.report.tracked[0].changes).toEqual([
      { reading: 2, before: "EIP-1967 implementation slot: 0xaaa", after: "EIP-1967 implementation slot: 0xbbb" },
    ]);

    await runProofs();
    const [proof] = await db
      .select()
      .from(schema.proofRecords)
      .where(and(eq(schema.proofRecords.kind, "period"), eq(schema.proofRecords.entityId, watch.id)));
    expect(proof).toMatchObject({ organizationId: org, engagementId: detail.engagementId });
    expect(proof.recordHash).toBe(keccak256(stringToBytes(proof.document)));
    const document = JSON.parse(proof.document);
    expect(document).toMatchObject({
      type: "905finance.period-report.v1",
      id: watch.id,
      seller: seller.id,
      work: "contract_check",
      periodDays: 5,
      compared: true,
      findings: { fromStartToEnd: 1, appeared: 0, resolved: 0, cameAndWent: 0, changed: 1 },
    });
    expect(document.readings.map((reading: { n: number; state: string; report: string }) => [reading.n, reading.state, reading.report])).toEqual(
      jobs.map((id, index) => [index + 1, "taken", id]),
    );
    // Each reading is named with the very findings hash its own report's proof carries.
    for (const [index, jobId] of jobs.entries()) {
      const [reading] = await db
        .select()
        .from(schema.proofRecords)
        .where(and(eq(schema.proofRecords.kind, "report"), eq(schema.proofRecords.entityId, jobId)));
      expect(JSON.parse(reading.document).findingsHash).toBe(document.readings[index].findingsHash);
    }
    // Running proofs again adds nothing: a period report is fingerprinted once.
    await runProofs();
    expect(
      await db.select().from(schema.proofRecords).where(and(eq(schema.proofRecords.kind, "period"), eq(schema.proofRecords.entityId, watch.id))),
    ).toHaveLength(1);
  });

  it("is written without the last reading when nobody took it, and says so", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Cut short", applicationUrl: "https://www.example.com" });
    const { engagementId, watch } = await watching(project.id, "website-5");
    await take([websiteFinding("A")]);
    await later(watch.id, DAY);
    await take([websiteFinding("A"), websiteFinding("B")]);

    // The rest of the period passes with no worker. Just before the grace period ends, the watch is still open.
    await later(watch.id, 4 * DAY + FINAL_GRACE_MS - HOUR);
    expect(await advanceWatches()).toEqual({ queued: 1, finished: 0 });
    expect((await watchOf(engagementId)).status).toBe("watching");
    // Once it has ended, a worker checking in finds the watch over and is given nothing to do.
    await later(watch.id, 2 * HOUR);
    const checkIn = await workerCheckIn({ workerId: "reader", tools: { webcheck: "1" }, supports: PAIRS });
    expect(checkIn).toEqual({ job: null, watchesFinished: 1 });

    const sentence = "5-day watch: 2 of 6 readings were taken (4 missed). 1 finding was there from start to end, 1 appeared, 0 were resolved.";
    expect(await watchOf(engagementId)).toMatchObject({ status: "reported", summary: sentence });
    expect(await purchaseOf(engagementId)).toMatchObject({ status: "delivered", delivery: { kind: "period_report" } });
    const detail = await getWatch(buyer, watch.id);
    expect(detail.readings.map((reading) => reading.state)).toEqual(["taken", "taken", "missed", "missed", "missed", "missed"]);
    await runProofs();
    const [proof] = await db
      .select()
      .from(schema.proofRecords)
      .where(and(eq(schema.proofRecords.kind, "period"), eq(schema.proofRecords.entityId, watch.id)));
    const document = JSON.parse(proof.document);
    expect(document.readings.slice(2).map((reading: { state: string; report: unknown; findings: unknown }) => [reading.state, reading.report, reading.findings])).toEqual(
      Array.from({ length: 4 }, () => ["missed", null, null]),
    );
  });

  it("delivers nothing, and proves nothing, when not one reading could be taken", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Never read", applicationUrl: "https://www.example.com" });
    const { engagementId, watch } = await watching(project.id, "website-1");
    await later(watch.id, DAY + FINAL_GRACE_MS + HOUR);
    expect(await advanceWatches({ watchId: watch.id })).toEqual({ queued: 0, finished: 1 });

    expect(await watchOf(engagementId)).toMatchObject({
      status: "failed",
      summary: "1-day watch: 0 of 5 readings were taken (5 missed). There is nothing to report.",
    });
    // The buyer paid and got nothing, and the record says exactly that.
    expect(await purchaseOf(engagementId)).toMatchObject({ status: "paid", delivery: null });
    const jobs = await jobsOf(engagementId);
    expect(jobs.map((job) => [job.reading, job.status, job.failureReason])).toEqual([[0, "failed", MISSED_READING]]);
    await runProofs();
    expect(
      await db.select().from(schema.proofRecords).where(and(eq(schema.proofRecords.kind, "period"), eq(schema.proofRecords.entityId, watch.id))),
    ).toEqual([]);
    const notes = await db
      .select()
      .from(schema.agentMessages)
      .where(and(eq(schema.agentMessages.engagementId, engagementId), eq(schema.agentMessages.kind, "watch_not_taken")));
    expect(notes).toHaveLength(1);
  });
});

describe("who can see a watch, and what the seller says about it", () => {
  it("is visible to the organization that bought it and to nobody else", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Private", applicationUrl: "https://www.example.com" });
    const { engagementId, watch } = await watching(project.id, "website-5");
    expect((await listWatches(buyer, org)).some((line) => line.id === watch.id)).toBe(true);
    expect((await listEngagementWatches(buyer, engagementId)).map((line) => line.id)).toEqual([watch.id]);

    const stranger = await createUser(db, "stranger");
    const strangerWs = await completeOnboarding(stranger, {
      displayName: "Stranger",
      organizationName: "Elsewhere",
      accountType: "business",
      roles: "buyer",
    });
    await expect(getWatch(stranger, watch.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(listEngagementWatches(stranger, engagementId)).rejects.toMatchObject({ code: "not_found" });
    await expect(listWatches(stranger, org)).rejects.toMatchObject({ code: "forbidden" });
    expect(await listWatches(stranger, strangerWs.organization.id)).toEqual([]);
    await expect(getWatch(null, watch.id)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(getWatch(buyer, "not-a-watch")).rejects.toMatchObject({ code: "not_found" });
  });

  it("is answered for as one order: under way until its report is written", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Asked after", applicationUrl: "https://www.example.com" });
    const { engagementId, watch } = await watching(project.id, "website-1");
    const purchase = await purchaseOf(engagementId);
    const first = await take([websiteFinding("A")]);
    const status = await answerAsSampleSeller(engagementId, { kind: "status_request", purchaseId: purchase.id });
    expect(status).toMatchObject({ kind: "status", purchaseId: purchase.id, jobId: first.id, state: "running" });
    expect(status.kind === "status" && status.summary).toContain("Watching for 1 day");

    for (let reading = 1; reading < 5; reading += 1) {
      await later(watch.id, 6 * HOUR);
      await take([websiteFinding("A")]);
    }
    expect(await answerAsSampleSeller(engagementId, { kind: "status_request", purchaseId: purchase.id })).toMatchObject({
      kind: "status",
      state: "completed",
      summary: "1-day watch: 5 of 5 readings were taken. 1 finding was there from start to end, 0 appeared, 0 were resolved.",
    });
    // An order sent twice starts one watch, not two.
    expect(await db.select().from(schema.watches).where(eq(schema.watches.purchaseId, purchase.id))).toHaveLength(1);
  });
});
