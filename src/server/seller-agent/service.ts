import "server-only";
import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { describeResult } from "@/lib/testing";
import type { AgentToSeller, SellerReply } from "../agent/transport";
import { isUuid } from "../authz";
import { offeringPriceUnits } from "../budget";
import { isAppError } from "../errors";
import { verifiedReceivingWallet } from "../identity";
import { simulatedRecipient } from "../payments/registry";
import { enqueueTestingJob, fulfilmentBlocker, repositoryBlocker } from "../testing/jobs";

const {
  engagements,
  sellerProfiles,
  serviceOfferings,
  projects,
  spendingMandates,
  purchases,
  paymentTransactions,
  testingJobs,
  testingResults,
} = schema;

/**
 * The seller's side of an engagement, for the platform's sample sellers.
 *
 * It answers three things: what a test costs, whether it will take on a test
 * that has been paid for, and how a test it took on is going. However a
 * request reaches it (the in-app channel or Qatom), the request is only a
 * set of claims. Each one is checked here against the platform's records:
 * that the engagement exists, is active and is with this seller; that the
 * service is one this seller offers; and, before any work is accepted, that
 * the payment named really was confirmed, for that purchase.
 *
 * It never states a test result of its own. Results come from the testing
 * worker, and this only relays what the worker reported.
 */

const refuse = (reason: string): SellerReply => ({ kind: "refusal", reason });

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function answerAsSampleSeller(
  engagementId: string,
  message: AgentToSeller,
): Promise<SellerReply> {
  if (!isUuid(engagementId)) return refuse("Unknown engagement.");
  const db = getDb();
  const [engagement] = await db.select().from(engagements).where(eq(engagements.id, engagementId));
  if (!engagement?.sellerProfileId || !engagement.rail) return refuse("Unknown engagement.");
  if (engagement.state !== "ACTIVE") return refuse("This engagement is not active.");

  const [seller] = await db
    .select()
    .from(sellerProfiles)
    .where(eq(sellerProfiles.id, engagement.sellerProfileId));
  // The platform answers for its own sample sellers and for nobody else.
  if (!seller?.isSample || seller.status !== "active") return refuse("This seller's agent is not available.");

  if (message.kind === "status_request") {
    return orderStatus(engagement.id, message.purchaseId);
  }

  const [offering] = isUuid(message.offeringId)
    ? await db.select().from(serviceOfferings).where(eq(serviceOfferings.id, message.offeringId))
    : [];
  if (!offering || offering.sellerProfileId !== seller.id || !offering.isActive) {
    return refuse("That service is not on offer.");
  }

  if (message.kind === "quote_request") {
    const [mandate] = await db
      .select({ asset: spendingMandates.asset, decimals: spendingMandates.assetDecimals })
      .from(spendingMandates)
      .where(eq(spendingMandates.engagementId, engagement.id));
    if (!mandate) return refuse("This engagement has no payment terms yet.");
    const [project] = await db.select().from(projects).where(eq(projects.id, engagement.projectId));

    const price = offeringPriceUnits(
      offering,
      { code: mandate.asset, decimals: mandate.decimals },
      message.quantity,
    );
    if (price === null) return refuse("That service cannot be priced.");
    // Decline before any payment if the test could not actually be run.
    const blocker = (await fulfilmentBlocker(project, offering.capability)) ?? (await repositoryBlocker(project));
    if (blocker) return refuse(blocker);
    // Where the seller asks to be paid: its simulated account, or, for an
    // engagement that settles on GOAT, the wallet its confirmed identity names.
    const recipient =
      engagement.settlement === "simulated"
        ? simulatedRecipient(engagement.rail, seller.id)
        : await verifiedReceivingWallet(seller.id);
    if (!recipient) return refuse("This seller has no confirmed receiving wallet on GOAT Network.");
    return {
      kind: "quote",
      offeringId: offering.id,
      quantity: message.quantity,
      asset: mandate.asset,
      amountUnits: price.toString(),
      recipient,
    };
  }

  // An order. Nothing is accepted on the buyer's word that it paid.
  if (!isUuid(message.purchaseId)) return refuse("Unknown order.");
  const [purchase] = await db.select().from(purchases).where(eq(purchases.id, message.purchaseId));
  if (
    !purchase ||
    purchase.engagementId !== engagement.id ||
    purchase.serviceOfferingId !== offering.id
  ) {
    return refuse("Unknown order.");
  }
  const [payment] = await db
    .select({ providerRef: paymentTransactions.providerRef })
    .from(paymentTransactions)
    .where(eq(paymentTransactions.purchaseId, purchase.id));
  if (!payment || !sameText(payment.providerRef, message.paymentReference)) {
    return refuse("No confirmed payment matches that reference.");
  }

  try {
    const job = await enqueueTestingJob(purchase.id);
    return { kind: "accepted", purchaseId: purchase.id, jobId: job.id };
  } catch (error) {
    if (!isAppError(error)) console.error("Could not queue a testing job", error);
    return refuse(isAppError(error) ? error.message : "The test could not be queued.");
  }
}

/** How an order this seller took on is going, as the testing worker has reported it. */
async function orderStatus(engagementId: string, purchaseId: string): Promise<SellerReply> {
  if (!isUuid(purchaseId)) return refuse("Unknown order.");
  const [row] = await getDb()
    .select({ job: testingJobs, result: testingResults })
    .from(testingJobs)
    .leftJoin(testingResults, eq(testingResults.jobId, testingJobs.id))
    .where(eq(testingJobs.purchaseId, purchaseId));
  if (!row || row.job.engagementId !== engagementId) return refuse("Unknown order.");

  const { job, result } = row;
  return {
    kind: "status",
    purchaseId,
    jobId: job.id,
    state: job.status,
    // The one-line summary of a static-analysis run needs its findings, which
    // the full report carries; here only runs with test counts are summarised.
    summary:
      result && (result.testsTotal !== null || result.outcome === "error")
        ? describeResult(result, [])
        : job.status === "failed"
          ? (job.failureReason ?? "The test did not complete.")
          : undefined,
  };
}
