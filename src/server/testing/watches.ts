import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema, type DbOrTx } from "@/db/client";
import type { Engagement, Finding, JobSource, Project, Purchase, ServiceOffering, TestingJob, TestingOutcome, Watch } from "@/db/schema";
import { SEVERITIES, type Severity } from "@/lib/testing";
import type { AssetInfo } from "@/lib/units";
import {
  describeWatch,
  readingClosesAt,
  readingDueAt,
  readingDueNow,
  readingEveryHours,
  readingsPlanned,
  summarizeWatch,
  watchEndsAt,
  type ReadingState,
  type WatchStatus,
  type WatchSummary,
} from "@/lib/watch";
import { assertAuthenticated, isUuid, requirePermission, requirePermissionOnRecord, type Actor } from "../authz";
import { notFound } from "../errors";

const {
  watches,
  testingJobs,
  testingResults,
  findings,
  purchases,
  engagements,
  projects,
  sellerProfiles,
  spendingMandates,
  agentMessages,
} = schema;

/**
 * Work over a period.
 *
 * A watch is one purchase of the same read-only look taken on a schedule. The
 * first reading is queued the moment the seller takes the order; the rest
 * are queued as they come due. Nothing here runs on a timer of its own: the
 * schedule is moved forward whenever a testing worker checks in, a reading is
 * handed in, or someone opens the watch. With no worker online no reading can
 * be taken, so the worker's own polling is all the clock that is needed.
 *
 * A reading that was not taken in time is recorded as missed. The period
 * report compares only the readings that really were taken.
 */

export const MISSED_READING = "No testing worker was online to take this reading in time.";
const STALLED_READING = "The testing worker stopped responding while taking this reading.";

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/**
 * Start the watch a purchase paid for, and queue its first reading. Called
 * inside the transaction that holds the purchase, with what is to be read
 * already worked out from the project's own records.
 */
export async function startWatch(
  tx: DbOrTx,
  input: {
    purchase: Purchase;
    engagement: Engagement;
    project: Pick<Project, "id">;
    offering: ServiceOffering;
    target: { key: string; source: JobSource };
    now?: Date;
  },
): Promise<{ watch: Watch; job: TestingJob }> {
  const { purchase, engagement, project, offering, target } = input;
  const startedAt = input.now ?? new Date();
  const periodDays = offering.periodDays!;
  const plan = { startedAt, everyHours: readingEveryHours(periodDays), readingsPlanned: readingsPlanned(periodDays) };
  const [watch] = await tx
    .insert(watches)
    .values({
      purchaseId: purchase.id,
      engagementId: engagement.id,
      projectId: project.id,
      sellerProfileId: offering.sellerProfileId,
      serviceOfferingId: offering.id,
      capability: offering.capability,
      fixtureKey: target.key,
      source: target.source,
      periodDays,
      ...plan,
      endsAt: watchEndsAt(plan),
    })
    .returning();
  const [job] = await tx.insert(testingJobs).values(readingJob(watch, 0)).returning();
  return { watch, job };
}

function readingJob(watch: Watch, reading: number): typeof testingJobs.$inferInsert {
  return {
    purchaseId: watch.purchaseId,
    engagementId: watch.engagementId,
    projectId: watch.projectId,
    sellerProfileId: watch.sellerProfileId,
    serviceOfferingId: watch.serviceOfferingId,
    capability: watch.capability,
    fixtureKey: watch.fixtureKey,
    source: watch.source,
    watchId: watch.id,
    reading,
  };
}

/** A project's watch of one kind that is still running, if it has one. */
export async function runningWatch(
  db: DbOrTx,
  projectId: string,
  capability: string,
): Promise<Pick<Watch, "id" | "endsAt"> | null> {
  const [found] = await db
    .select({ id: watches.id, endsAt: watches.endsAt })
    .from(watches)
    .where(and(eq(watches.projectId, projectId), eq(watches.capability, capability), eq(watches.status, "watching")))
    .limit(1);
  return found ?? null;
}

// ---------------------------------------------------------------------------
// Moving the schedule forward
// ---------------------------------------------------------------------------

export type WatchProgress = {
  /** Readings queued because they came due. */
  queued: number;
  /** Watches whose period report was written. */
  finished: number;
};

/**
 * Bring every running watch up to date: record readings that were missed,
 * queue the reading that is due, and write the period report of a watch that
 * has ended. Safe to call as often as anyone likes, from anywhere.
 */
export async function advanceWatches(options: { now?: Date; watchId?: string } = {}): Promise<WatchProgress> {
  const now = options.now ?? new Date();
  const db = getDb();
  const progress: WatchProgress = { queued: 0, finished: 0 };
  if (options.watchId !== undefined && !isUuid(options.watchId)) return progress;
  const running = await db
    .select({ id: watches.id })
    .from(watches)
    .where(and(eq(watches.status, "watching"), options.watchId ? eq(watches.id, options.watchId) : undefined))
    .orderBy(watches.sequence)
    .limit(500);

  for (const { id } of running) {
    await db.transaction(async (tx) => {
      // Someone else moving this watch forward right now is doing the same work.
      const [watch] = await tx
        .select()
        .from(watches)
        .where(and(eq(watches.id, id), eq(watches.status, "watching")))
        .for("update", { skipLocked: true });
      if (!watch) return;
      const jobs = await tx.select().from(testingJobs).where(eq(testingJobs.watchId, watch.id));
      const last = watch.readingsPlanned - 1;

      // A reading nobody took before its time ran out is missed, not taken late.
      for (const job of jobs) {
        if (job.reading === null || now < readingClosesAt(watch, job.reading)) continue;
        const stalled = job.status === "running" && job.leaseExpiresAt !== null && job.leaseExpiresAt < now;
        if (job.status !== "queued" && !stalled) continue;
        job.status = "failed";
        await tx
          .update(testingJobs)
          .set({
            status: "failed",
            finishedAt: now,
            leaseExpiresAt: null,
            failureReason: stalled ? STALLED_READING : MISSED_READING,
            updatedAt: now,
          })
          .where(eq(testingJobs.id, job.id));
      }

      const due = readingDueNow(watch, now);
      if (!jobs.some((job) => job.reading === due) && now < readingClosesAt(watch, due)) {
        const [queued] = await tx.insert(testingJobs).values(readingJob(watch, due)).returning();
        jobs.push(queued);
        progress.queued += 1;
      }

      const open = jobs.some((job) => job.status === "queued" || job.status === "running");
      const final = jobs.find((job) => job.reading === last);
      const finalDone = final !== undefined && (final.status === "completed" || final.status === "failed");
      if (!open && (finalDone || now >= readingClosesAt(watch, last))) {
        await finishWatch(tx, watch, now);
        progress.finished += 1;
      }
    });
  }
  return progress;
}

/** Write a watch's period report, and mark its purchase delivered if there is anything to report. */
async function finishWatch(tx: DbOrTx, watch: Watch, now: Date): Promise<void> {
  const readings = await loadReadings(tx, { ...watch, status: "reported" }, now);
  const summary = summarizeReadings(watch, readings);
  const sentence = describeWatch(watch.periodDays, summary);
  const status: WatchStatus = summary.taken > 0 ? "reported" : "failed";
  await tx.update(watches).set({ status, finishedAt: now, summary: sentence }).where(eq(watches.id, watch.id));
  if (status === "reported") {
    await tx
      .update(purchases)
      .set({
        status: "delivered",
        delivery: { kind: "period_report", watchId: watch.id, summary: sentence },
        updatedAt: now,
      })
      .where(and(eq(purchases.id, watch.purchaseId), eq(purchases.status, "paid")));
  }
  await tx.insert(agentMessages).values({
    engagementId: watch.engagementId,
    direction: "platform",
    kind: status === "reported" ? "watch_reported" : "watch_not_taken",
    body: { watchId: watch.id, purchaseId: watch.purchaseId, message: sentence },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type SeverityCounts = Record<Severity, number>;

export type ReadingDetail = {
  /** Numbered from 0, the first look. */
  reading: number;
  dueAt: Date;
  state: ReadingState;
  /** The reading's own report, when a job was made for it. */
  jobId: string | null;
  outcome: TestingOutcome | null;
  takenAt: Date | null;
  /** Why it was not taken, in words, when it was not. */
  note: string | null;
  findings: Finding[];
  counts: SeverityCounts;
};

/** Every planned reading of a watch, taken or not, with what each one found. */
export async function loadReadings(db: DbOrTx, watch: Watch, now: Date = new Date()): Promise<ReadingDetail[]> {
  const rows = await db
    .select({ job: testingJobs, result: testingResults })
    .from(testingJobs)
    .leftJoin(testingResults, eq(testingResults.jobId, testingJobs.id))
    .where(eq(testingJobs.watchId, watch.id));
  const jobIds = rows.map((row) => row.job.id);
  const found =
    jobIds.length > 0
      ? await db.select().from(findings).where(inArray(findings.jobId, jobIds)).orderBy(findings.sequence)
      : [];
  const over = watch.status !== "watching";

  return Array.from({ length: watch.readingsPlanned }, (_, reading): ReadingDetail => {
    const row = rows.find((entry) => entry.job.reading === reading);
    const dueAt = readingDueAt(watch, reading);
    const mine = row ? found.filter((finding) => finding.jobId === row.job.id) : [];
    const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const finding of mine) counts[finding.severity] += 1;

    let state: ReadingState;
    let note: string | null = null;
    if (!row) {
      state = over || now >= readingClosesAt(watch, reading) ? "missed" : now >= dueAt ? "waiting" : "scheduled";
      if (state === "missed") note = MISSED_READING;
    } else if (row.job.status === "completed") {
      state = "taken";
    } else if (row.job.status === "failed") {
      state = row.result === null && row.job.failureReason === MISSED_READING ? "missed" : "unreadable";
      note = row.result?.errorMessage ?? row.job.failureReason ?? "The reading did not complete.";
    } else {
      state = "waiting";
    }
    return {
      reading,
      dueAt,
      state,
      jobId: row?.job.id ?? null,
      outcome: row?.result?.outcome ?? null,
      takenAt: state === "taken" ? (row?.result?.createdAt ?? row?.job.finishedAt ?? null) : null,
      note,
      findings: state === "taken" ? mine : [],
      counts,
    };
  });
}

export function summarizeReadings(watch: Pick<Watch, "readingsPlanned">, readings: ReadingDetail[]): WatchSummary {
  return summarizeWatch(
    watch.readingsPlanned,
    readings.map((entry) => ({ reading: entry.reading, state: entry.state, findings: entry.findings })),
  );
}

export type WatchLine = {
  id: string;
  engagementId: string;
  purchaseId: string;
  projectId: string;
  projectName: string;
  sellerProfileId: string;
  sellerName: string;
  offeringName: string;
  capability: string;
  source: JobSource;
  periodDays: number;
  everyHours: number;
  readingsPlanned: number;
  /** Readings a tool ran to completion for. */
  readingsTaken: number;
  startedAt: Date;
  endsAt: Date;
  status: WatchStatus;
  finishedAt: Date | null;
  summary: string | null;
  /** What the buyer was charged for the whole watch. */
  chargeUnits: bigint;
  asset: AssetInfo;
  isSimulatedPayment: boolean;
};

const lineColumns = {
  watch: watches,
  projectName: projects.name,
  sellerName: sellerProfiles.displayName,
  offeringName: purchases.offeringName,
  chargeUnits: purchases.amountUnits,
  assetCode: purchases.asset,
  assetDecimals: spendingMandates.assetDecimals,
  isSimulatedPayment: purchases.isSimulated,
  organizationId: engagements.organizationId,
};

function lineQuery() {
  return getDb()
    .select(lineColumns)
    .from(watches)
    .innerJoin(engagements, eq(engagements.id, watches.engagementId))
    .innerJoin(purchases, eq(purchases.id, watches.purchaseId))
    .innerJoin(projects, eq(projects.id, watches.projectId))
    .innerJoin(sellerProfiles, eq(sellerProfiles.id, watches.sellerProfileId))
    .leftJoin(spendingMandates, eq(spendingMandates.engagementId, watches.engagementId));
}

type LineRow = Awaited<ReturnType<typeof lineQuery>>[number];

function toLine(row: LineRow, readingsTaken: number): WatchLine {
  const { watch } = row;
  return {
    id: watch.id,
    engagementId: watch.engagementId,
    purchaseId: watch.purchaseId,
    projectId: watch.projectId,
    projectName: row.projectName,
    sellerProfileId: watch.sellerProfileId,
    sellerName: row.sellerName,
    offeringName: row.offeringName,
    capability: watch.capability,
    source: watch.source,
    periodDays: watch.periodDays,
    everyHours: watch.everyHours,
    readingsPlanned: watch.readingsPlanned,
    readingsTaken,
    startedAt: watch.startedAt,
    endsAt: watch.endsAt,
    status: watch.status as WatchStatus,
    finishedAt: watch.finishedAt,
    summary: watch.summary,
    chargeUnits: row.chargeUnits,
    asset: { code: row.assetCode, decimals: row.assetDecimals ?? 2 },
    isSimulatedPayment: row.isSimulatedPayment,
  };
}

async function takenCounts(watchIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (watchIds.length === 0) return counts;
  const rows = await getDb()
    .select({ watchId: testingJobs.watchId })
    .from(testingJobs)
    .where(and(inArray(testingJobs.watchId, watchIds), eq(testingJobs.status, "completed")));
  for (const row of rows) if (row.watchId) counts.set(row.watchId, (counts.get(row.watchId) ?? 0) + 1);
  return counts;
}

/** An organization's watches, newest first. */
export async function listWatches(actor: Actor | null, organizationId: string): Promise<WatchLine[]> {
  await requirePermission(actor, organizationId, "engagement.view");
  const rows = await lineQuery()
    .where(eq(engagements.organizationId, organizationId))
    .orderBy(desc(watches.sequence))
    .limit(200);
  const counts = await takenCounts(rows.map((row) => row.watch.id));
  return rows.map((row) => toLine(row, counts.get(row.watch.id) ?? 0));
}

/** One engagement's watches, newest first. */
export async function listEngagementWatches(actor: Actor | null, engagementId: string): Promise<WatchLine[]> {
  assertAuthenticated(actor);
  if (!isUuid(engagementId)) throw notFound("Engagement");
  const [engagement] = await getDb().select().from(engagements).where(eq(engagements.id, engagementId));
  await requirePermissionOnRecord(actor, engagement, "engagement.view", "Engagement");
  const rows = await lineQuery().where(eq(watches.engagementId, engagementId)).orderBy(desc(watches.sequence));
  const counts = await takenCounts(rows.map((row) => row.watch.id));
  return rows.map((row) => toLine(row, counts.get(row.watch.id) ?? 0));
}

export type WatchDetail = WatchLine & {
  readings: ReadingDetail[];
  /** The comparison of the readings taken so far; final once the watch has finished. */
  report: WatchSummary;
};

/** One watch: its schedule, every reading, and the comparison of what the readings found. */
export async function getWatch(actor: Actor | null, watchId: string, now: Date = new Date()): Promise<WatchDetail> {
  assertAuthenticated(actor);
  if (!isUuid(watchId)) throw notFound("Watch");
  const [row] = await lineQuery().where(eq(watches.id, watchId));
  await requirePermissionOnRecord(actor, row, "engagement.view", "Watch");
  const readings = await loadReadings(getDb(), row.watch, now);
  return {
    ...toLine(row, readings.filter((entry) => entry.state === "taken").length),
    readings,
    report: summarizeReadings(row.watch, readings),
  };
}

/** The counts a list needs for one severity breakdown. */
export function totalFindings(counts: SeverityCounts): number {
  return SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0);
}
