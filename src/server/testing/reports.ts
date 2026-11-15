import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { Finding, JobSource, TestingJobStatus, TestingOutcome } from "@/db/schema";
import { describeResult, SEVERITIES, type Severity } from "@/lib/testing";
import type { AssetInfo } from "@/lib/units";
import { assertAuthenticated, isUuid, requirePermission, requirePermissionOnRecord, type Actor } from "../authz";
import { notFound } from "../errors";

const {
  testingJobs,
  testingResults,
  findings,
  purchases,
  engagements,
  projects,
  sellerProfiles,
  spendingMandates,
  paymentTransactions,
} = schema;

/**
 * Read access to testing jobs and their reports, for the organization that
 * bought the testing. Every figure returned is one a worker reported and the
 * platform stored; a job with no report yet has none.
 */

export type SeverityCounts = Record<Severity, number>;

export type JobLine = {
  id: string;
  engagementId: string;
  purchaseId: string;
  projectId: string;
  projectName: string;
  sellerProfileId: string;
  sellerName: string;
  offeringName: string;
  capability: string;
  status: TestingJobStatus;
  failureReason: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  /** Null until a worker has reported. */
  result: {
    outcome: TestingOutcome;
    tool: string;
    testsTotal: number | null;
    testsPassed: number | null;
    testsFailed: number | null;
    testsSkipped: number | null;
    durationMs: number;
    summary: string;
  } | null;
  findingCounts: SeverityCounts;
  findingsTotal: number;
  /** What the buyer was charged for this job. */
  chargeUnits: bigint;
  asset: AssetInfo;
  isSimulatedPayment: boolean;
};

const emptyCounts = (): SeverityCounts => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

const jobColumns = {
  job: testingJobs,
  result: testingResults,
  projectName: projects.name,
  sellerName: sellerProfiles.displayName,
  offeringName: purchases.offeringName,
  chargeUnits: purchases.amountUnits,
  assetCode: purchases.asset,
  assetDecimals: spendingMandates.assetDecimals,
  isSimulatedPayment: purchases.isSimulated,
  organizationId: engagements.organizationId,
};

function jobQuery() {
  return getDb()
    .select(jobColumns)
    .from(testingJobs)
    .innerJoin(engagements, eq(engagements.id, testingJobs.engagementId))
    .innerJoin(purchases, eq(purchases.id, testingJobs.purchaseId))
    .innerJoin(projects, eq(projects.id, testingJobs.projectId))
    .innerJoin(sellerProfiles, eq(sellerProfiles.id, testingJobs.sellerProfileId))
    .leftJoin(spendingMandates, eq(spendingMandates.engagementId, testingJobs.engagementId))
    .leftJoin(testingResults, eq(testingResults.jobId, testingJobs.id));
}

type JobRow = Awaited<ReturnType<typeof jobQuery>>[number];

async function severityCounts(jobIds: string[]): Promise<Map<string, SeverityCounts>> {
  const counts = new Map<string, SeverityCounts>();
  if (jobIds.length === 0) return counts;
  const rows = await getDb()
    .select({ jobId: findings.jobId, severity: findings.severity, total: sql<number>`count(*)::int` })
    .from(findings)
    .where(inArray(findings.jobId, jobIds))
    .groupBy(findings.jobId, findings.severity);
  for (const row of rows) {
    const entry = counts.get(row.jobId) ?? emptyCounts();
    entry[row.severity] = row.total;
    counts.set(row.jobId, entry);
  }
  return counts;
}

function toJobLine(row: JobRow, counts: SeverityCounts): JobLine {
  const { job, result } = row;
  const findingsTotal = SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0);
  // The one-line summary needs each finding's severity, which the counts carry.
  const severities = SEVERITIES.flatMap((severity) =>
    Array.from({ length: counts[severity] }, () => ({ severity })),
  );
  return {
    id: job.id,
    engagementId: job.engagementId,
    purchaseId: job.purchaseId,
    projectId: job.projectId,
    projectName: row.projectName,
    sellerProfileId: job.sellerProfileId,
    sellerName: row.sellerName,
    offeringName: row.offeringName,
    capability: job.capability,
    status: job.status,
    failureReason: job.failureReason,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    result: result
      ? {
          outcome: result.outcome,
          tool: result.tool,
          testsTotal: result.testsTotal,
          testsPassed: result.testsPassed,
          testsFailed: result.testsFailed,
          testsSkipped: result.testsSkipped,
          durationMs: result.durationMs,
          summary: describeResult(result, severities),
        }
      : null,
    findingCounts: counts,
    findingsTotal,
    chargeUnits: row.chargeUnits,
    asset: { code: row.assetCode, decimals: row.assetDecimals ?? 2 },
    isSimulatedPayment: row.isSimulatedPayment,
  };
}

async function toJobLines(rows: JobRow[]): Promise<JobLine[]> {
  const counts = await severityCounts(rows.map((row) => row.job.id));
  return rows.map((row) => toJobLine(row, counts.get(row.job.id) ?? emptyCounts()));
}

/** An organization's testing jobs, newest first. */
export async function listTestingJobs(
  actor: Actor | null,
  organizationId: string,
  options: { limit?: number } = {},
): Promise<JobLine[]> {
  await requirePermission(actor, organizationId, "engagement.view");
  const rows = await jobQuery()
    .where(eq(engagements.organizationId, organizationId))
    .orderBy(desc(testingJobs.sequence))
    .limit(Math.min(options.limit ?? 200, 200));
  return toJobLines(rows);
}

/** One engagement's testing jobs, newest first. */
export async function listEngagementJobs(actor: Actor | null, engagementId: string): Promise<JobLine[]> {
  assertAuthenticated(actor);
  if (!isUuid(engagementId)) throw notFound("Engagement");
  const [engagement] = await getDb().select().from(engagements).where(eq(engagements.id, engagementId));
  await requirePermissionOnRecord(actor, engagement, "engagement.view", "Engagement");
  const rows = await jobQuery()
    .where(eq(testingJobs.engagementId, engagementId))
    .orderBy(desc(testingJobs.sequence))
    .limit(200);
  return toJobLines(rows);
}

export type TestingReport = JobLine & {
  fixtureKey: string;
  /** What was read, when the job was for something the buyer shared. Null for a bundled project. */
  source: JobSource | null;
  attempts: number;
  claimedAt: Date | null;
  execution: {
    toolVersion: string;
    command: string;
    exitCode: number | null;
    log: string;
    errorMessage: string | null;
    workerId: string;
    reportedAt: Date;
  } | null;
  findings: Finding[];
  /** The payment provider's reference for the charge, when the payment is confirmed. */
  paymentReference: string | null;
  paymentRail: string | null;
};

/** The full report for one job: figures, findings, evidence and the charge. */
export async function getTestingReport(actor: Actor | null, jobId: string): Promise<TestingReport> {
  assertAuthenticated(actor);
  if (!isUuid(jobId)) throw notFound("Report");
  const [row] = await jobQuery().where(eq(testingJobs.id, jobId));
  await requirePermissionOnRecord(actor, row, "engagement.view", "Report");

  const db = getDb();
  const found = await db
    .select()
    .from(findings)
    .where(eq(findings.jobId, row.job.id))
    .orderBy(findings.sequence);
  const order = new Map(SEVERITIES.map((severity, index) => [severity, index]));
  found.sort((a, b) => order.get(a.severity)! - order.get(b.severity)! || a.sequence - b.sequence);
  const counts = emptyCounts();
  for (const finding of found) counts[finding.severity] += 1;

  const [payment] = await db
    .select({ providerRef: paymentTransactions.providerRef, rail: paymentTransactions.rail })
    .from(paymentTransactions)
    .where(eq(paymentTransactions.purchaseId, row.job.purchaseId));

  return {
    ...toJobLine(row, counts),
    fixtureKey: row.job.fixtureKey,
    source: row.job.source ?? null,
    attempts: row.job.attempts,
    claimedAt: row.job.claimedAt,
    execution: row.result
      ? {
          toolVersion: row.result.toolVersion,
          command: row.result.command,
          exitCode: row.result.exitCode,
          log: row.result.log,
          errorMessage: row.result.errorMessage,
          workerId: row.result.workerId,
          reportedAt: row.result.createdAt,
        }
      : null,
    findings: found,
    paymentReference: payment?.providerRef ?? null,
    paymentRail: payment?.rail ?? null,
  };
}

export type FindingLine = {
  id: string;
  jobId: string;
  title: string;
  severity: Severity;
  category: string;
  location: string;
  projectName: string;
  createdAt: Date;
};

export type TestingOverview = {
  jobs: Record<TestingJobStatus, number>;
  findings: SeverityCounts;
  recentFindings: FindingLine[];
};

/** Counts for the dashboard: jobs by status, findings by severity, and the latest findings. */
export async function getTestingOverview(actor: Actor | null, organizationId: string): Promise<TestingOverview> {
  await requirePermission(actor, organizationId, "engagement.view");
  const db = getDb();
  const mine = eq(engagements.organizationId, organizationId);

  const jobRows = await db
    .select({ status: testingJobs.status, total: sql<number>`count(*)::int` })
    .from(testingJobs)
    .innerJoin(engagements, eq(engagements.id, testingJobs.engagementId))
    .where(mine)
    .groupBy(testingJobs.status);
  const jobs: TestingOverview["jobs"] = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const row of jobRows) jobs[row.status] = row.total;

  const findingRows = await db
    .select({ severity: findings.severity, total: sql<number>`count(*)::int` })
    .from(findings)
    .innerJoin(testingJobs, eq(testingJobs.id, findings.jobId))
    .innerJoin(engagements, eq(engagements.id, testingJobs.engagementId))
    .where(mine)
    .groupBy(findings.severity);
  const bySeverity = emptyCounts();
  for (const row of findingRows) bySeverity[row.severity] = row.total;

  const recent = await db
    .select({ finding: findings, projectName: projects.name })
    .from(findings)
    .innerJoin(testingJobs, eq(testingJobs.id, findings.jobId))
    .innerJoin(engagements, eq(engagements.id, testingJobs.engagementId))
    .innerJoin(projects, eq(projects.id, testingJobs.projectId))
    .where(and(mine, inArray(findings.severity, ["critical", "high", "medium"])))
    .orderBy(desc(findings.sequence))
    .limit(6);

  return {
    jobs,
    findings: bySeverity,
    recentFindings: recent.map(({ finding, projectName }) => ({
      id: finding.id,
      jobId: finding.jobId,
      title: finding.title,
      severity: finding.severity,
      category: finding.category,
      location: finding.location,
      projectName,
      createdAt: finding.createdAt,
    })),
  };
}
