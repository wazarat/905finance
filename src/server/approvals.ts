import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, schema, type Tx } from "@/db/client";
import type {
  ApprovalKind,
  ApprovalRequest,
  ApprovalStatus,
  Engagement,
  EngagementState,
  Purchase,
} from "@/db/schema";
import { formatUnits, parseUnits, type AssetInfo } from "@/lib/units";
import { recordAudit } from "./audit";
import { assertAuthenticated, isUuid, requirePermission, type Actor } from "./authz";
import { getBudgetStatus, offeringPriceUnits, type BudgetStatus } from "./budget";
import { transition, withEngagement } from "./engagement-core";
import { conflict, invalid, notFound } from "./errors";

const {
  approvalRequests,
  engagements,
  spendingMandates,
  mandatePermittedOfferings,
  serviceOfferings,
  sellerProfiles,
  projects,
} = schema;

// ---------------------------------------------------------------------------
// Raising a request (called by the policy engine, never by a person)
// ---------------------------------------------------------------------------

/**
 * Record that the agent needs a person's decision, and pause the engagement.
 * While paused, no further paid work can begin.
 */
export async function openApprovalRequest(
  tx: Tx,
  engagement: Engagement,
  input: {
    kind: ApprovalKind;
    purchase: Purchase;
    budget: BudgetStatus;
    shortfallUnits: bigint;
    explanation: string;
  },
): Promise<{ approval: ApprovalRequest; engagement: Engagement }> {
  const [approval] = await tx
    .insert(approvalRequests)
    .values({
      engagementId: engagement.id,
      kind: input.kind,
      purchaseId: input.purchase.id,
      serviceOfferingId: input.purchase.serviceOfferingId,
      offeringName: input.purchase.offeringName,
      asset: input.budget.asset.code,
      assetDecimals: input.budget.asset.decimals,
      proposedAmountUnits: input.purchase.amountUnits,
      totalAuthorizedUnits: input.budget.totalUnits,
      spentUnits: input.budget.spentUnits,
      reservedUnits: input.budget.reservedUnits,
      walletBalanceUnits: input.budget.walletBalanceUnits,
      shortfallUnits: input.shortfallUnits,
      explanation: input.explanation,
    })
    .returning();

  const paused = await transition(
    tx,
    engagement,
    "PAUSED_FOR_APPROVAL",
    null,
    input.kind === "budget_increase"
      ? "Paused: the next purchase needs a higher budget."
      : "Paused: the next purchase needs more funds in the wallet.",
  );
  await recordAudit(
    {
      actorUserId: null,
      organizationId: engagement.organizationId,
      action: "approval.requested",
      entityType: "approval_request",
      entityId: approval.id,
      metadata: {
        kind: input.kind,
        engagementId: engagement.id,
        proposedAmountUnits: input.purchase.amountUnits.toString(),
        shortfallUnits: input.shortfallUnits.toString(),
      },
    },
    tx,
  );
  return { approval, engagement: paused };
}

// ---------------------------------------------------------------------------
// Decisions (owner only)
// ---------------------------------------------------------------------------

async function findEngagementId(approvalId: string): Promise<string> {
  if (!isUuid(approvalId)) throw notFound("Approval request");
  const [row] = await getDb()
    .select({ engagementId: approvalRequests.engagementId })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalId));
  if (!row) throw notFound("Approval request");
  return row.engagementId;
}

async function loadPending(tx: Tx, approvalId: string, engagement: Engagement): Promise<ApprovalRequest> {
  const [approval] = await tx
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, approvalId), eq(approvalRequests.engagementId, engagement.id)))
    .for("update");
  if (!approval) throw notFound("Approval request");
  if (approval.status !== "pending" || engagement.state !== "PAUSED_FOR_APPROVAL") {
    throw conflict("This request has already been decided.");
  }
  return approval;
}

async function resume(tx: Tx, engagement: Engagement, actorUserId: string, note: string) {
  return transition(tx, engagement, "ACTIVE", actorUserId, note);
}

/**
 * Approve a higher total budget. This changes the mandate and nothing else:
 * no funds move, the wallet is untouched, and the permitted services, scope,
 * per-purchase limit, seller and expiry stay exactly as they were.
 */
export async function approveBudgetIncrease(
  actor: Actor | null,
  approvalId: string,
  input: { newTotal: string; confirmed: unknown },
): Promise<ApprovalRequest> {
  assertAuthenticated(actor);
  if (input.confirmed !== true) {
    throw invalid("Confirm that you approve this budget.", {
      confirmed: ["Confirm that you approve this budget."],
    });
  }
  const engagementId = await findEngagementId(approvalId);
  return withEngagement(actor, engagementId, "engagement.approve", async (tx, engagement, who) => {
    const approval = await loadPending(tx, approvalId, engagement);
    if (approval.kind !== "budget_increase") {
      throw conflict("This request is for funding, not for a budget increase.");
    }
    const [mandate] = await tx
      .select()
      .from(spendingMandates)
      .where(eq(spendingMandates.engagementId, engagement.id))
      .for("update");
    const budget = await getBudgetStatus(tx, engagement.id);
    if (!mandate || mandate.status !== "authorized" || !budget) {
      throw conflict("This engagement has no authorized mandate.");
    }

    const asset: AssetInfo = { code: mandate.asset, decimals: mandate.assetDecimals };
    const newTotal = parseUnits(input.newTotal, asset.decimals);
    const needed = budget.spentUnits + budget.reservedUnits + approval.proposedAmountUnits;
    if (newTotal === null || newTotal <= mandate.totalAuthorizedUnits) {
      throw invalid("Check the highlighted fields.", {
        newTotal: [
          `Enter a total above the current ${formatUnits(mandate.totalAuthorizedUnits, asset)}.`,
        ],
      });
    }
    if (newTotal < needed) {
      throw invalid("Check the highlighted fields.", {
        newTotal: [`The proposed work needs a total of at least ${formatUnits(needed, asset)}.`],
      });
    }

    await tx
      .update(spendingMandates)
      .set({ totalAuthorizedUnits: newTotal, version: mandate.version + 1 })
      .where(eq(spendingMandates.id, mandate.id));
    const [decided] = await tx
      .update(approvalRequests)
      .set({
        status: "approved",
        approvedTotalUnits: newTotal,
        decidedBy: who.userId,
        decidedAt: new Date(),
      })
      .where(eq(approvalRequests.id, approval.id))
      .returning();
    await resume(tx, engagement, who.userId, "Budget increase approved by the buyer. No funds moved.");
    await recordAudit(
      {
        actorUserId: who.userId,
        organizationId: engagement.organizationId,
        action: "mandate.budget_increased",
        entityType: "spending_mandate",
        entityId: mandate.id,
        metadata: {
          approvalRequestId: approval.id,
          fromUnits: mandate.totalAuthorizedUnits.toString(),
          toUnits: newTotal.toString(),
          asset: asset.code,
          fundsMoved: false,
        },
      },
      tx,
    );
    return decided;
  });
}

/** Decline the request. The engagement resumes within its existing budget and funds. */
export async function rejectApproval(actor: Actor | null, approvalId: string): Promise<ApprovalRequest> {
  assertAuthenticated(actor);
  const engagementId = await findEngagementId(approvalId);
  return withEngagement(actor, engagementId, "engagement.approve", async (tx, engagement, who) => {
    const approval = await loadPending(tx, approvalId, engagement);
    const [decided] = await tx
      .update(approvalRequests)
      .set({ status: "rejected", decidedBy: who.userId, decidedAt: new Date() })
      .where(eq(approvalRequests.id, approval.id))
      .returning();
    await resume(tx, engagement, who.userId, "Request declined by the buyer. Limits unchanged.");
    await recordAudit(
      {
        actorUserId: who.userId,
        organizationId: engagement.organizationId,
        action: "approval.rejected",
        entityType: "approval_request",
        entityId: approval.id,
        metadata: { kind: approval.kind },
      },
      tx,
    );
    return decided;
  });
}

/**
 * Change the proposed work instead of raising the budget: the buyer names a
 * different permitted service that fits the limits already in place. Nothing
 * about the mandate changes.
 */
export async function modifyProposedWork(
  actor: Actor | null,
  approvalId: string,
  input: { replacementOfferingId: string },
): Promise<ApprovalRequest> {
  assertAuthenticated(actor);
  const engagementId = await findEngagementId(approvalId);
  return withEngagement(actor, engagementId, "engagement.approve", async (tx, engagement, who) => {
    const approval = await loadPending(tx, approvalId, engagement);
    if (approval.kind !== "budget_increase") {
      throw conflict("Only a budget request can be changed to different work.");
    }
    const budget = await getBudgetStatus(tx, engagement.id);
    if (!budget) throw conflict("This engagement has no authorized mandate.");
    if (!isUuid(input.replacementOfferingId)) {
      throw invalid("Check the highlighted fields.", {
        replacementOfferingId: ["Choose one of the permitted services."],
      });
    }
    const [offering] = await tx
      .select({ offering: serviceOfferings })
      .from(mandatePermittedOfferings)
      .innerJoin(serviceOfferings, eq(serviceOfferings.id, mandatePermittedOfferings.serviceOfferingId))
      .where(
        and(
          eq(mandatePermittedOfferings.mandateId, budget.mandateId),
          eq(serviceOfferings.id, input.replacementOfferingId),
          eq(serviceOfferings.isActive, true),
        ),
      );
    const price = offering ? offeringPriceUnits(offering.offering, budget.asset) : null;
    if (!offering || price === null) {
      throw invalid("Check the highlighted fields.", {
        replacementOfferingId: ["Choose one of the permitted services."],
      });
    }
    if (
      price > budget.remainingUnits ||
      price > budget.perTransactionUnits ||
      price > budget.walletAvailableUnits
    ) {
      throw invalid("Check the highlighted fields.", {
        replacementOfferingId: ["That service does not fit the remaining budget and funds either."],
      });
    }

    const [decided] = await tx
      .update(approvalRequests)
      .set({
        status: "modified",
        replacementOfferingId: offering.offering.id,
        decidedBy: who.userId,
        decidedAt: new Date(),
        decisionNote: `Do "${offering.offering.name}" instead.`,
      })
      .where(eq(approvalRequests.id, approval.id))
      .returning();
    await resume(tx, engagement, who.userId, "Proposed work changed by the buyer. Limits unchanged.");
    await recordAudit(
      {
        actorUserId: who.userId,
        organizationId: engagement.organizationId,
        action: "approval.modified",
        entityType: "approval_request",
        entityId: approval.id,
        metadata: { replacementOfferingId: offering.offering.id },
      },
      tx,
    );
    return decided;
  });
}

/**
 * Called after a funding authorization has credited the wallet: if a funding
 * request was waiting and the wallet can now cover the proposed purchase, the
 * request is settled and the engagement resumes. The funding itself was the
 * person's authorization; this only records that it answered the request.
 */
export async function settleFundingRequest(
  tx: Tx,
  engagement: Engagement,
  actorUserId: string,
): Promise<Engagement> {
  if (engagement.state !== "PAUSED_FOR_APPROVAL") return engagement;
  const [approval] = await tx
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.engagementId, engagement.id),
        eq(approvalRequests.status, "pending"),
        eq(approvalRequests.kind, "additional_funding"),
      ),
    )
    .for("update");
  if (!approval) return engagement;
  const budget = await getBudgetStatus(tx, engagement.id);
  if (!budget || budget.walletAvailableUnits < approval.proposedAmountUnits) return engagement;

  await tx
    .update(approvalRequests)
    .set({
      status: "approved",
      decidedBy: actorUserId,
      decidedAt: new Date(),
      decisionNote: "Answered by a separate funding authorization.",
    })
    .where(eq(approvalRequests.id, approval.id));
  return resume(tx, engagement, actorUserId, "Additional funding authorized by the buyer.");
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ApprovalSummary = {
  id: string;
  engagementId: string;
  engagementState: EngagementState;
  kind: ApprovalKind;
  status: ApprovalStatus;
  sellerName: string;
  projectName: string;
  offeringName: string;
  asset: AssetInfo;
  proposedAmountUnits: bigint;
  totalAuthorizedUnits: bigint;
  spentUnits: bigint;
  reservedUnits: bigint;
  walletBalanceUnits: bigint;
  shortfallUnits: bigint;
  explanation: string;
  approvedTotalUnits: bigint | null;
  decisionNote: string;
  decidedAt: Date | null;
  createdAt: Date;
};

export function toApprovalSummary(
  approval: ApprovalRequest,
  context: { engagementState: EngagementState; sellerName: string; projectName: string },
): ApprovalSummary {
  return {
    id: approval.id,
    engagementId: approval.engagementId,
    engagementState: context.engagementState,
    kind: approval.kind,
    status: approval.status,
    sellerName: context.sellerName,
    projectName: context.projectName,
    offeringName: approval.offeringName,
    asset: { code: approval.asset, decimals: approval.assetDecimals },
    proposedAmountUnits: approval.proposedAmountUnits,
    totalAuthorizedUnits: approval.totalAuthorizedUnits,
    spentUnits: approval.spentUnits,
    reservedUnits: approval.reservedUnits,
    walletBalanceUnits: approval.walletBalanceUnits,
    shortfallUnits: approval.shortfallUnits,
    explanation: approval.explanation,
    approvedTotalUnits: approval.approvedTotalUnits,
    decisionNote: approval.decisionNote,
    decidedAt: approval.decidedAt,
    createdAt: approval.createdAt,
  };
}

/** Every approval request for an organization's engagements, newest first. */
export async function listApprovals(
  actor: Actor | null,
  organizationId: string,
): Promise<ApprovalSummary[]> {
  await requirePermission(actor, organizationId, "engagement.view");
  const rows = await getDb()
    .select({
      approval: approvalRequests,
      engagementState: engagements.state,
      sellerName: sellerProfiles.displayName,
      projectName: projects.name,
    })
    .from(approvalRequests)
    .innerJoin(engagements, eq(engagements.id, approvalRequests.engagementId))
    .innerJoin(sellerProfiles, eq(sellerProfiles.id, engagements.sellerProfileId))
    .innerJoin(projects, eq(projects.id, engagements.projectId))
    .where(eq(engagements.organizationId, organizationId))
    .orderBy(desc(approvalRequests.sequence))
    .limit(100);
  return rows.map((row) => toApprovalSummary(row.approval, row));
}

/** How many of the caller's organization's requests are waiting for a decision. */
export async function countPendingApprovals(tx: Tx | ReturnType<typeof getDb>, organizationId: string) {
  const rows = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .innerJoin(engagements, eq(engagements.id, approvalRequests.engagementId))
    .where(and(eq(engagements.organizationId, organizationId), eq(approvalRequests.status, "pending")));
  return rows.length;
}

/** Offerings the buyer turned down a budget increase for; the agent does not propose them again. */
export async function declinedOfferingIds(tx: Tx | ReturnType<typeof getDb>, engagementId: string) {
  const rows = await tx
    .select({ id: approvalRequests.serviceOfferingId })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.engagementId, engagementId),
        inArray(approvalRequests.status, ["rejected", "modified"]),
      ),
    );
  return rows.map((r) => r.id).filter((id): id is string => id !== null);
}
