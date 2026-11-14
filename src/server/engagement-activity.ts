import "server-only";
import { asc, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type {
  AgentRun,
  MessageDirection,
  PurchaseStatus,
  TestingJobStatus,
  TestingOutcome,
} from "@/db/schema";
import { describeResult } from "@/lib/testing";
import type { AssetInfo } from "@/lib/units";
import { resolveSellerTransport } from "./agent/transport";
import { toApprovalSummary, type ApprovalSummary } from "./approvals";
import { assertAuthenticated, isUuid, requirePermissionOnRecord, roleHasPermission, type Actor } from "./authz";
import { getBudgetStatus, offeringPriceUnits, type BudgetStatus } from "./budget";
import { notFound } from "./errors";
import { fulfilmentBlocker, getWorkerStatus } from "./testing/jobs";

const {
  engagements,
  sellerProfiles,
  projects,
  serviceOfferings,
  mandatePermittedOfferings,
  purchases,
  paymentTransactions,
  approvalRequests,
  agentMessages,
  agentRuns,
  testingJobs,
  testingResults,
} = schema;

export type PurchaseLine = {
  id: string;
  offeringName: string;
  quantity: number;
  amountUnits: bigint;
  asset: AssetInfo;
  status: PurchaseStatus;
  message: string | null;
  paymentReference: string | null;
  deliverySummary: string | null;
  /** The test this purchase paid for, once it has been queued. */
  job: {
    id: string;
    status: TestingJobStatus;
    outcome: TestingOutcome | null;
    /** What the tool reported, or why the test did not run. Null while it is waiting. */
    summary: string | null;
  } | null;
  isSimulated: boolean;
  createdAt: Date;
};

export type MessageLine = {
  id: string;
  direction: MessageDirection;
  kind: string;
  body: Record<string, unknown>;
  createdAt: Date;
};

export type EngagementActivity = {
  /** Null until the engagement has a mandate. */
  budget: BudgetStatus | null;
  purchases: PurchaseLine[];
  pendingApproval: ApprovalSummary | null;
  approvals: ApprovalSummary[];
  /** Permitted services that would fit the current limits, for "do this instead". */
  alternatives: Array<{ id: string; name: string; priceUnits: bigint }>;
  messages: MessageLine[];
  lastRun: AgentRun | null;
  /** How the seller's agent is reached, or null when it is not connected. */
  sellerConnection: { description: string; simulated: boolean } | null;
  /** Whether the tests this engagement may buy can be executed right now. Null when no seller is connected. */
  testing: {
    workerOnline: boolean;
    services: Array<{ id: string; name: string; blocker: string | null }>;
  } | null;
  can: { operate: boolean; approve: boolean };
};

/** What an engagement's agent has done: budget use, purchases, approvals and messages. */
export async function getEngagementActivity(
  actor: Actor | null,
  engagementId: string,
): Promise<EngagementActivity> {
  assertAuthenticated(actor);
  if (!isUuid(engagementId)) throw notFound("Engagement");
  const db = getDb();
  const [engagement] = await db.select().from(engagements).where(eq(engagements.id, engagementId));
  const membership = await requirePermissionOnRecord(actor, engagement, "engagement.view", "Engagement");
  if (!engagement.sellerProfileId) throw notFound("Engagement");

  const [seller] = await db
    .select()
    .from(sellerProfiles)
    .where(eq(sellerProfiles.id, engagement.sellerProfileId));
  const [project] = await db.select().from(projects).where(eq(projects.id, engagement.projectId));
  const budget = await getBudgetStatus(db, engagement.id);
  const asset: AssetInfo = budget?.asset ?? { code: "", decimals: 0 };

  const purchaseRows = await db
    .select({
      purchase: purchases,
      providerRef: paymentTransactions.providerRef,
      job: testingJobs,
      result: testingResults,
    })
    .from(purchases)
    .leftJoin(paymentTransactions, eq(paymentTransactions.purchaseId, purchases.id))
    .leftJoin(testingJobs, eq(testingJobs.purchaseId, purchases.id))
    .leftJoin(testingResults, eq(testingResults.jobId, testingJobs.id))
    .where(eq(purchases.engagementId, engagement.id))
    .orderBy(desc(purchases.sequence))
    .limit(100);

  const approvalRows = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.engagementId, engagement.id))
    .orderBy(desc(approvalRequests.sequence));
  const approvals = approvalRows.map((approval) =>
    toApprovalSummary(approval, {
      engagementState: engagement.state,
      sellerName: seller.displayName,
      projectName: project.name,
    }),
  );

  const permitted = budget
    ? await db
        .select({ offering: serviceOfferings })
        .from(mandatePermittedOfferings)
        .innerJoin(serviceOfferings, eq(serviceOfferings.id, mandatePermittedOfferings.serviceOfferingId))
        .where(eq(mandatePermittedOfferings.mandateId, budget.mandateId))
        .orderBy(asc(serviceOfferings.priceMinor))
    : [];
  const alternatives = budget
    ? permitted.flatMap(({ offering }) => {
        const price = offering.isActive ? offeringPriceUnits(offering, budget.asset) : null;
        const fits =
          price !== null &&
          price <= budget.remainingUnits &&
          price <= budget.perTransactionUnits &&
          price <= budget.walletAvailableUnits;
        return fits && price !== null ? [{ id: offering.id, name: offering.name, priceUnits: price }] : [];
      })
    : [];

  const messageRows = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.engagementId, engagement.id))
    .orderBy(desc(agentMessages.sequence))
    .limit(60);
  const [lastRun] = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.engagementId, engagement.id))
    .orderBy(desc(agentRuns.startedAt))
    .limit(1);

  const offerings = await db
    .select()
    .from(serviceOfferings)
    .where(eq(serviceOfferings.sellerProfileId, seller.id));
  const transport =
    engagement.rail && budget
      ? resolveSellerTransport({ seller, offerings, project, rail: engagement.rail, asset: budget.asset })
      : null;

  let testing: EngagementActivity["testing"] = null;
  if (transport) {
    const services = [];
    for (const { offering } of permitted) {
      if (!offering.isActive) continue;
      services.push({
        id: offering.id,
        name: offering.name,
        blocker: await fulfilmentBlocker(project, offering.capability, db),
      });
    }
    testing = { workerOnline: (await getWorkerStatus()).online, services };
  }

  return {
    budget,
    testing,
    purchases: purchaseRows.map(({ purchase, providerRef, job, result }) => ({
      id: purchase.id,
      offeringName: purchase.offeringName,
      quantity: purchase.quantity,
      amountUnits: purchase.amountUnits,
      asset,
      status: purchase.status,
      message: purchase.blockMessage,
      paymentReference: providerRef,
      deliverySummary:
        purchase.delivery && typeof purchase.delivery.summary === "string"
          ? purchase.delivery.summary
          : null,
      job: job
        ? {
            id: job.id,
            status: job.status,
            outcome: result?.outcome ?? null,
            // Findings are not loaded here; the summary of a static-analysis run comes from the stored delivery.
            summary:
              result && (result.testsTotal !== null || result.outcome === "error")
                ? describeResult(result, [])
                : typeof purchase.delivery?.summary === "string"
                  ? purchase.delivery.summary
                  : job.status === "failed"
                    ? (job.failureReason ?? "The test did not complete.")
                    : null,
          }
        : null,
      isSimulated: purchase.isSimulated,
      createdAt: purchase.createdAt,
    })),
    pendingApproval: approvals.find((a) => a.status === "pending") ?? null,
    approvals,
    alternatives,
    messages: messageRows.reverse().map((m) => ({
      id: m.id,
      direction: m.direction,
      kind: m.kind,
      body: m.body,
      createdAt: m.createdAt,
    })),
    lastRun: lastRun ?? null,
    sellerConnection: transport
      ? { description: transport.description, simulated: transport.simulated }
      : null,
    can: {
      operate: roleHasPermission(membership.role, "engagement.operate"),
      approve: roleHasPermission(membership.role, "engagement.approve"),
    },
  };
}
