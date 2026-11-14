import "server-only";
import { and, asc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema, type DbOrTx } from "@/db/client";
import type { Project, TestingJob } from "@/db/schema";
import { getCapability } from "@/lib/capabilities";
import { CAPABILITY_TOOLS, SEVERITIES, describeResult } from "@/lib/testing";
import { conflict, invalid, notFound } from "../errors";

const { testingJobs, testingResults, findings, testingWorkers, purchases, engagements, projects, serviceOfferings, agentMessages } =
  schema;

/**
 * The testing-job queue.
 *
 * A job is created for a purchase that has been paid for, and only for work a
 * live testing worker has said it can run. Workers reach this module through
 * two HTTP endpoints and nothing else: they are handed a fixture name and a
 * test type, and hand back a report. They never see the engagement, the
 * mandate, the wallet or any credential.
 *
 * Nothing in here produces a test figure. Counts, findings and logs are
 * stored exactly as the worker reported them, after checking that the report
 * is internally consistent and came from the tool the job called for.
 */

/** A worker that has not checked in for this long is treated as offline. */
export const WORKER_LIVE_MS = 60_000;
/** How long a worker may hold a job before it is assumed to have died. */
export const JOB_LEASE_MS = 10 * 60_000;
export const MAX_JOB_ATTEMPTS = 3;
const MAX_STORED_LOG = 200_000;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const pair = (fixtureKey: string, capability: string) => `${fixtureKey}:${capability}`;

// ---------------------------------------------------------------------------
// Can this work be done at all?
// ---------------------------------------------------------------------------

export type WorkerSupport = "ready" | "offline" | "unsupported";

/** Whether any live worker has said it can run a test type against a fixture. */
export async function workerSupport(
  fixtureKey: string,
  capability: string,
  db: DbOrTx = getDb(),
): Promise<WorkerSupport> {
  const live = await db
    .select({ supports: testingWorkers.supports })
    .from(testingWorkers)
    .where(gt(testingWorkers.lastSeenAt, new Date(Date.now() - WORKER_LIVE_MS)));
  if (live.length === 0) return "offline";
  return live.some((worker) => worker.supports.includes(pair(fixtureKey, capability))) ? "ready" : "unsupported";
}

/**
 * Why a test type cannot be run against a project right now, in words for
 * the buyer, or null when it can. Asked before a price is quoted, so that
 * nobody pays for a test that would never execute.
 */
export async function fulfilmentBlocker(
  project: Pick<Project, "sourceType" | "fixtureKey">,
  capability: string,
  db: DbOrTx = getDb(),
): Promise<string | null> {
  if (project.sourceType !== "fixture" || !project.fixtureKey) {
    return "Testing is available for the bundled sample projects only. Running tests against your own repository is not available yet.";
  }
  const label = getCapability(capability)?.label ?? capability;
  const support = await workerSupport(project.fixtureKey, capability, db);
  if (support === "offline") {
    return "No testing worker is online, so this test cannot be run right now.";
  }
  if (support === "unsupported") {
    return `No testing worker can run "${label}" against this project.`;
  }
  return null;
}

export type WorkerStatus = {
  online: boolean;
  /** Tool name to version, for each tool at least one live worker has. */
  tools: Record<string, string>;
  /** Test types a live worker can run against the fixture asked about. */
  capabilities: string[];
};

/** What the live workers can do, optionally narrowed to one fixture. No secrets are involved. */
export async function getWorkerStatus(fixtureKey?: string | null): Promise<WorkerStatus> {
  const live = await getDb()
    .select()
    .from(testingWorkers)
    .where(gt(testingWorkers.lastSeenAt, new Date(Date.now() - WORKER_LIVE_MS)));
  const tools: Record<string, string> = {};
  const capabilities = new Set<string>();
  for (const worker of live) {
    for (const [tool, version] of Object.entries(worker.tools)) {
      if (version) tools[tool] = version;
    }
    for (const entry of worker.supports) {
      const [fixture, capability] = entry.split(":");
      if (!fixtureKey || fixture === fixtureKey) capabilities.add(capability);
    }
  }
  return { online: live.length > 0, tools, capabilities: [...capabilities].sort() };
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

/**
 * Queue the test a purchase paid for. Everything about the job is read from
 * platform records for that purchase: nothing a seller or an agent says can
 * choose the project, the test type or what is executed. Calling it again for
 * the same purchase returns the same job.
 */
export async function enqueueTestingJob(purchaseId: string): Promise<TestingJob> {
  if (!uuid.safeParse(purchaseId).success) throw notFound("Purchase");
  return getDb().transaction(async (tx) => {
    const [purchase] = await tx.select().from(purchases).where(eq(purchases.id, purchaseId)).for("update");
    if (!purchase) throw notFound("Purchase");

    const [existing] = await tx.select().from(testingJobs).where(eq(testingJobs.purchaseId, purchase.id));
    if (existing) return existing;

    if (purchase.status !== "paid") throw conflict("Only a paid purchase can be tested.");
    const [engagement] = await tx.select().from(engagements).where(eq(engagements.id, purchase.engagementId));
    const [project] = await tx.select().from(projects).where(eq(projects.id, engagement.projectId));
    const [offering] = await tx
      .select()
      .from(serviceOfferings)
      .where(eq(serviceOfferings.id, purchase.serviceOfferingId));
    if (!engagement.sellerProfileId || offering.sellerProfileId !== engagement.sellerProfileId) {
      throw conflict("The purchase does not belong to this engagement's seller.");
    }
    if (project.sourceType !== "fixture" || !project.fixtureKey) {
      throw conflict("Only the bundled sample projects can be tested.");
    }

    const [job] = await tx
      .insert(testingJobs)
      .values({
        purchaseId: purchase.id,
        engagementId: engagement.id,
        projectId: project.id,
        sellerProfileId: engagement.sellerProfileId,
        serviceOfferingId: offering.id,
        capability: offering.capability,
        fixtureKey: project.fixtureKey,
      })
      .returning();
    return job;
  });
}

// ---------------------------------------------------------------------------
// Worker: claim
// ---------------------------------------------------------------------------

const claimInput = z
  .object({
    workerId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    tools: z.record(z.string().regex(/^[a-z]{1,20}$/), z.string().max(200).nullable()),
    supports: z.array(z.string().regex(/^[a-z0-9-]{1,60}:[a-z_]{1,60}$/)).max(100),
  })
  .strict();

export type ClaimedJob = { id: string; fixtureKey: string; capability: string };

/** Put a job a worker stopped working on back in the queue, or give up on it after too many tries. */
async function releaseJobs(tx: DbOrTx, where: ReturnType<typeof and>): Promise<void> {
  const now = new Date();
  await tx
    .update(testingJobs)
    .set({
      status: "failed",
      finishedAt: now,
      leaseExpiresAt: null,
      failureReason: "The testing worker stopped responding each time it ran this job.",
      updatedAt: now,
    })
    .where(and(where, eq(testingJobs.status, "running"), sql`${testingJobs.attempts} >= ${MAX_JOB_ATTEMPTS}`));
  await tx
    .update(testingJobs)
    .set({ status: "queued", claimedBy: null, claimedAt: null, leaseExpiresAt: null, updatedAt: now })
    .where(and(where, eq(testingJobs.status, "running")));
}

/**
 * A worker checks in and asks for work. Its check-in records what it can
 * run; it is then given the oldest queued job it supports, if there is one.
 */
export async function claimTestingJob(raw: unknown): Promise<ClaimedJob | null> {
  const parsed = claimInput.safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data.tools).length > 10) {
    throw invalid("The worker's check-in was not understood.");
  }
  const { workerId, tools, supports } = parsed.data;
  const now = new Date();

  return getDb().transaction(async (tx) => {
    await tx
      .insert(testingWorkers)
      .values({ workerId, tools, supports, lastSeenAt: now })
      .onConflictDoUpdate({ target: testingWorkers.workerId, set: { tools, supports, lastSeenAt: now } });

    // A worker runs one job at a time, so one asking for work has abandoned
    // whatever it held. Jobs whose lease ran out were abandoned by someone.
    await releaseJobs(tx, or(eq(testingJobs.claimedBy, workerId), lt(testingJobs.leaseExpiresAt, now)));

    if (supports.length === 0) return null;
    const [next] = await tx
      .select()
      .from(testingJobs)
      .where(
        and(
          eq(testingJobs.status, "queued"),
          inArray(sql<string>`${testingJobs.fixtureKey} || ':' || ${testingJobs.capability}`, supports),
        ),
      )
      .orderBy(asc(testingJobs.sequence))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!next) return null;

    await tx
      .update(testingJobs)
      .set({
        status: "running",
        attempts: next.attempts + 1,
        claimedBy: workerId,
        claimedAt: now,
        leaseExpiresAt: new Date(now.getTime() + JOB_LEASE_MS),
        updatedAt: now,
      })
      .where(eq(testingJobs.id, next.id));
    return { id: next.id, fixtureKey: next.fixtureKey, capability: next.capability };
  });
}

// ---------------------------------------------------------------------------
// Worker: result
// ---------------------------------------------------------------------------

const count = z.number().int().min(0).max(1_000_000).nullable().optional();

const findingInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    severity: z.enum(SEVERITIES),
    category: z.enum(["test_failure", "static_analysis", "compiler"]),
    location: z.string().max(500).nullish(),
    evidence: z.string().max(20_000).nullish(),
    recommendation: z.string().max(2_000).nullish(),
  })
  .strict();

const resultInput = z
  .object({
    outcome: z.enum(["passed", "failed", "error"]),
    tool: z.string().max(20),
    toolVersion: z.string().max(200).nullish(),
    command: z.string().max(1_000).nullish(),
    exitCode: z.number().int().nullish(),
    durationMs: z.number().min(0).max(3_600_000),
    log: z.string().max(2_000_000).nullish(),
    error: z.string().max(2_000).nullish(),
    testsTotal: count,
    testsPassed: count,
    testsFailed: count,
    testsSkipped: count,
    findings: z.array(findingInput).max(200).default([]),
  })
  .strict();

type ResultInput = z.infer<typeof resultInput>;

/**
 * Reasons a report cannot be what it claims to be. A report that contradicts
 * itself is refused whole rather than stored in part.
 */
function inconsistency(report: ResultInput, capability: string): string | null {
  const counts = [report.testsTotal, report.testsPassed, report.testsFailed, report.testsSkipped].map(
    (value) => value ?? null,
  );
  const [total, passed, failed, skipped] = counts;
  const present = counts.filter((value) => value !== null).length;
  if (present !== 0 && present !== 4) return "Test counts must be given together or not at all.";
  if (total !== null && passed! + failed! + skipped! !== total) return "Test counts do not add up.";

  if (report.outcome === "error") {
    return report.error?.trim() ? null : "A run that could not complete must say why.";
  }
  if (report.tool !== CAPABILITY_TOOLS[capability]) {
    return "The report did not come from the tool this job calls for.";
  }
  const serious = report.findings.some((f) => f.severity !== "low" && f.severity !== "info");
  if (report.outcome === "passed" && ((failed ?? 0) > 0 || serious)) {
    return "A run with failures cannot be reported as passed.";
  }
  if (report.outcome === "failed" && (failed ?? 0) === 0 && report.findings.length === 0) {
    return "A failed run must show what failed.";
  }
  if (total !== null && failed! > 0 && report.findings.length === 0) {
    return "Failing tests must be reported as findings.";
  }
  return null;
}

export type SubmitOutcome = { jobId: string; status: TestingJob["status"]; replayed: boolean };

/**
 * A worker hands back the report for a job it holds. The report is validated,
 * stored with its findings, and the purchase is marked delivered when the
 * tool ran to completion. A run that could not complete leaves the purchase
 * paid and undelivered, and says why.
 */
export async function submitTestingResult(jobId: string, raw: unknown): Promise<SubmitOutcome> {
  if (!uuid.safeParse(jobId).success) throw notFound("Job");
  const envelope = z
    .object({ workerId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), result: resultInput })
    .strict()
    .safeParse(raw);
  if (!envelope.success) throw invalid("The report was not in the expected form.");
  const { workerId, result } = envelope.data;

  return getDb().transaction(async (tx) => {
    const [job] = await tx.select().from(testingJobs).where(eq(testingJobs.id, jobId)).for("update");
    if (!job) throw notFound("Job");

    if (job.status === "completed" || job.status === "failed") {
      const [stored] = await tx.select().from(testingResults).where(eq(testingResults.jobId, job.id));
      if (stored && stored.workerId === workerId) return { jobId: job.id, status: job.status, replayed: true };
      throw conflict("This job is already finished.");
    }
    if (job.status !== "running" || job.claimedBy !== workerId) {
      throw conflict("This job is not held by that worker.");
    }
    const problem = inconsistency(result, job.capability);
    if (problem) throw invalid(problem);

    const now = new Date();
    const figures = {
      outcome: result.outcome,
      tool: result.tool,
      testsTotal: result.testsTotal ?? null,
      testsPassed: result.testsPassed ?? null,
      testsFailed: result.testsFailed ?? null,
      testsSkipped: result.testsSkipped ?? null,
      errorMessage: result.error?.trim() || null,
    };
    await tx.insert(testingResults).values({
      ...figures,
      jobId: job.id,
      durationMs: Math.round(result.durationMs),
      toolVersion: result.toolVersion ?? "",
      command: result.command ?? "",
      exitCode: result.exitCode ?? null,
      log: (result.log ?? "").slice(0, MAX_STORED_LOG),
      workerId,
    });
    if (result.findings.length > 0) {
      await tx.insert(findings).values(
        result.findings.map((finding) => ({
          jobId: job.id,
          title: finding.title,
          severity: finding.severity,
          category: finding.category,
          location: finding.location ?? "",
          evidence: finding.evidence ?? "",
          recommendation: finding.recommendation ?? "",
        })),
      );
    }

    const status = result.outcome === "error" ? "failed" : "completed";
    await tx
      .update(testingJobs)
      .set({
        status,
        finishedAt: now,
        leaseExpiresAt: null,
        failureReason: status === "failed" ? figures.errorMessage : null,
        updatedAt: now,
      })
      .where(eq(testingJobs.id, job.id));

    const summary = describeResult(figures, result.findings);
    if (status === "completed") {
      await tx
        .update(purchases)
        .set({
          status: "delivered",
          delivery: { kind: "test_report", jobId: job.id, outcome: result.outcome, summary },
          updatedAt: now,
        })
        .where(and(eq(purchases.id, job.purchaseId), eq(purchases.status, "paid")));
    }
    // A note for the engagement's activity feed. It is the platform speaking,
    // from its own records, so it does not depend on the engagement's state.
    await tx.insert(agentMessages).values({
      engagementId: job.engagementId,
      direction: "platform",
      kind: status === "completed" ? "test_completed" : "test_not_run",
      body: { jobId: job.id, purchaseId: job.purchaseId, message: summary },
    });
    return { jobId: job.id, status, replayed: false };
  });
}
