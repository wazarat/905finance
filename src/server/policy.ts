import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { getDb, schema, type Tx } from "@/db/client";
import type { PaymentAttempt, Purchase } from "@/db/schema";
import { ENGAGEMENT_STATE_LABELS } from "@/lib/engagement-state";
import { formatUnits } from "@/lib/units";
import { openApprovalRequest } from "./approvals";
import { recordAudit } from "./audit";
import { assertAuthenticated, isUuid, type Actor } from "./authz";
import { getBudgetStatus, offeringPriceUnits } from "./budget";
import { closeEngagement, isPastDeadline, withEngagement } from "./engagement-core";
import { conflict, notFound } from "./errors";
import type { PaymentProvider, PaymentResult } from "./payments/provider";
import { getPaymentProvider, simulatedRecipient } from "./payments/registry";

const {
  engagements,
  purchases,
  spendingReservations,
  paymentAttempts,
  paymentTransactions,
  spendingMandates,
  mandatePermittedOfferings,
  serviceOfferings,
  purchasingAgents,
  engagementWallets,
  walletLedgerEntries,
  agentMessages,
} = schema;

/**
 * The spending policy engine.
 *
 * Every purchase an agent wants to make goes through `executePurchase`, and
 * nothing else can pay a seller. The decision is made from platform records
 * only; nothing the agent or the seller says is taken on trust:
 *
 *   1. the engagement is active
 *   2. the seller is the one selected for it
 *   3. the payment recipient is the one the mandate authorizes
 *   4. the service is one the mandate permits
 *   5. the asset and amount match the mandate and the listed price
 *   6. the budget has room (and the per-purchase limit is respected)
 *   7. the wallet has the funds
 *   8. spending capacity is reserved, atomically
 *   9. the payment is executed through the rail's provider
 *  10. the outcome is verified
 *  11. the outcome is recorded
 *
 * A failed check blocks the purchase and is recorded. A payment whose outcome
 * is unknown keeps its reservation and waits for reconciliation; it is never
 * retried automatically.
 */

export type BlockReason =
  | "engagement_not_active"
  | "wrong_seller"
  | "recipient_not_authorized"
  | "service_not_permitted"
  | "asset_mismatch"
  | "amount_mismatch"
  | "per_purchase_limit"
  | "budget_exceeded"
  | "insufficient_wallet_funds";

export type PurchaseRequest = {
  engagementId: string;
  offeringId: string;
  quantity?: number;
  /** One key per intended purchase. Repeating it returns the first outcome. */
  idempotencyKey: string;
  /** The terms the seller quoted. Checked against the listing and the mandate. */
  quote: { sellerProfileId: string; asset: string; amountUnits: bigint; recipient: string };
  agentRunId?: string | null;
  /** The agent's stated reason, shown to the buyer if approval is needed. */
  explanation?: string;
};

export type PurchaseOutcome =
  | { status: "paid"; purchase: Purchase; replayed: boolean }
  | { status: "blocked"; purchase: Purchase | null; reason: BlockReason; message: string; approvalRequested: boolean; replayed: boolean }
  | { status: "payment_failed"; purchase: Purchase; message: string; replayed: boolean }
  | { status: "needs_reconciliation"; purchase: Purchase; message: string; replayed: boolean };

type Prepared =
  | { kind: "outcome"; outcome: PurchaseOutcome }
  | {
      kind: "pay";
      purchase: Purchase;
      attempt: PaymentAttempt;
      provider: PaymentProvider;
      walletRef: string;
    };

function outcomeOf(purchase: Purchase, replayed: boolean): PurchaseOutcome {
  switch (purchase.status) {
    case "paid":
    case "delivered":
      return { status: "paid", purchase, replayed };
    case "payment_failed":
      return { status: "payment_failed", purchase, message: "The payment failed. Nothing was charged.", replayed };
    case "blocked":
      return {
        status: "blocked",
        purchase,
        reason: (purchase.blockReason ?? "engagement_not_active") as BlockReason,
        message: purchase.blockMessage ?? "The purchase was blocked.",
        approvalRequested: false,
        replayed,
      };
    default:
      return {
        status: "needs_reconciliation",
        purchase,
        message: "The payment's outcome is not known yet. It will be reconciled, not retried.",
        replayed,
      };
  }
}

async function note(
  tx: Tx,
  engagementId: string,
  agentRunId: string | null | undefined,
  kind: string,
  body: Record<string, unknown>,
) {
  await tx.insert(agentMessages).values({
    engagementId,
    agentRunId: agentRunId ?? null,
    direction: "platform",
    kind,
    body,
  });
}

/** Steps 1 to 8: every check, then the reservation and the payment attempt record. */
async function prepare(request: PurchaseRequest): Promise<Prepared> {
  return getDb().transaction(async (tx): Promise<Prepared> => {
    const refuse = (reason: BlockReason, message: string): Prepared => ({
      kind: "outcome",
      outcome: { status: "blocked", purchase: null, reason, message, approvalRequested: false, replayed: false },
    });
    if (!isUuid(request.engagementId) || !isUuid(request.offeringId)) {
      return refuse("engagement_not_active", "Unknown engagement or service.");
    }

    // Locking the engagement makes purchases for it take turns, so two
    // simultaneous requests cannot both pass the budget check.
    const [engagement] = await tx
      .select()
      .from(engagements)
      .where(eq(engagements.id, request.engagementId))
      .for("update");
    if (!engagement) return refuse("engagement_not_active", "Unknown engagement.");

    const [earlier] = await tx
      .select()
      .from(purchases)
      .where(eq(purchases.idempotencyKey, request.idempotencyKey));
    if (earlier) {
      if (earlier.engagementId !== engagement.id) {
        return refuse("engagement_not_active", "That purchase key belongs to another engagement.");
      }
      return { kind: "outcome", outcome: outcomeOf(earlier, true) };
    }

    if (isPastDeadline(engagement, new Date())) {
      await closeEngagement(tx, engagement, "EXPIRED", null, "The engagement reached its deadline.");
      return refuse("engagement_not_active", "The engagement has expired.");
    }

    const [offering] = await tx
      .select()
      .from(serviceOfferings)
      .where(eq(serviceOfferings.id, request.offeringId));
    const quantity = request.quantity ?? 1;

    /** Record a blocked request so everything the agent tried is on file. */
    const block = async (
      reason: BlockReason,
      message: string,
      amountUnits: bigint,
      asset: string,
    ): Promise<{ purchase: Purchase | null; prepared: Prepared }> => {
      let purchase: Purchase | null = null;
      if (offering && amountUnits > 0n && Number.isInteger(quantity) && quantity > 0) {
        [purchase] = await tx
          .insert(purchases)
          .values({
            engagementId: engagement.id,
            agentRunId: request.agentRunId ?? null,
            serviceOfferingId: offering.id,
            offeringName: offering.name,
            quantity,
            asset,
            amountUnits,
            recipient: request.quote.recipient.slice(0, 500),
            idempotencyKey: request.idempotencyKey,
            status: "blocked",
            blockReason: reason,
            blockMessage: message,
          })
          .returning();
      }
      await note(tx, engagement.id, request.agentRunId, "purchase_blocked", {
        reason,
        message,
        service: offering?.name ?? null,
      });
      await recordAudit(
        {
          actorUserId: null,
          organizationId: engagement.organizationId,
          action: "purchase.blocked",
          entityType: "purchase",
          entityId: purchase?.id ?? null,
          metadata: { engagementId: engagement.id, reason, offeringId: request.offeringId },
        },
        tx,
      );
      return {
        purchase,
        prepared: {
          kind: "outcome",
          outcome: { status: "blocked", purchase, reason, message, approvalRequested: false, replayed: false },
        },
      };
    };

    // 1. The engagement is active, with an authorized mandate, an active agent and an active wallet.
    const [mandate] = await tx
      .select()
      .from(spendingMandates)
      .where(eq(spendingMandates.engagementId, engagement.id))
      .for("update");
    const [agent] = await tx
      .select()
      .from(purchasingAgents)
      .where(eq(purchasingAgents.engagementId, engagement.id));
    const [wallet] = await tx
      .select()
      .from(engagementWallets)
      .where(eq(engagementWallets.engagementId, engagement.id))
      .for("update");
    const quotedAsset = request.quote.asset.slice(0, 40);
    if (
      engagement.state !== "ACTIVE" ||
      !engagement.rail ||
      !engagement.sellerProfileId ||
      !mandate ||
      mandate.status !== "authorized" ||
      agent?.status !== "active" ||
      wallet?.status !== "active"
    ) {
      const reason =
        engagement.state === "ACTIVE"
          ? "The engagement's mandate, agent or wallet is not active."
          : `The engagement is ${ENGAGEMENT_STATE_LABELS[engagement.state].toLowerCase()}, so nothing can be purchased.`;
      return (await block("engagement_not_active", reason, request.quote.amountUnits, quotedAsset)).prepared;
    }
    const asset = { code: mandate.asset, decimals: mandate.assetDecimals };

    // 2. The seller is the one selected for this engagement.
    if (
      !offering ||
      offering.sellerProfileId !== engagement.sellerProfileId ||
      request.quote.sellerProfileId !== engagement.sellerProfileId ||
      mandate.sellerProfileId !== engagement.sellerProfileId
    ) {
      return (
        await block(
          "wrong_seller",
          "That service does not belong to the seller selected for this engagement.",
          request.quote.amountUnits,
          quotedAsset,
        )
      ).prepared;
    }

    // 3. The recipient is the one the mandate authorizes, whatever the seller asked for.
    const provider = getPaymentProvider(engagement.rail, engagement.settlement);
    const authorizedRecipient =
      mandate.authorizedRecipient ??
      (provider.simulated ? simulatedRecipient(engagement.rail, engagement.sellerProfileId) : null);
    if (!authorizedRecipient || request.quote.recipient !== authorizedRecipient) {
      return (
        await block(
          "recipient_not_authorized",
          "The seller asked to be paid at an account the mandate does not authorize.",
          request.quote.amountUnits,
          quotedAsset,
        )
      ).prepared;
    }

    // 4. The service is one the mandate permits, and is still offered.
    const [permitted] = await tx
      .select({ id: mandatePermittedOfferings.serviceOfferingId })
      .from(mandatePermittedOfferings)
      .where(
        and(
          eq(mandatePermittedOfferings.mandateId, mandate.id),
          eq(mandatePermittedOfferings.serviceOfferingId, offering.id),
        ),
      );
    if (!permitted || !offering.isActive) {
      return (
        await block(
          "service_not_permitted",
          `"${offering.name}" is not a service this mandate permits.`,
          request.quote.amountUnits,
          quotedAsset,
        )
      ).prepared;
    }

    // 5. The asset is the mandate's, and the amount is the listed price, exactly.
    if (request.quote.asset !== asset.code) {
      return (
        await block(
          "asset_mismatch",
          `The seller quoted in ${quotedAsset}, but this mandate pays in ${asset.code}.`,
          request.quote.amountUnits,
          quotedAsset,
        )
      ).prepared;
    }
    const listed =
      Number.isInteger(quantity) && quantity > 0 && quantity <= 1000
        ? offeringPriceUnits(offering, asset, quantity)
        : null;
    if (listed === null || request.quote.amountUnits !== listed) {
      return (
        await block(
          "amount_mismatch",
          listed === null
            ? "The price of that service cannot be determined."
            : `The seller quoted ${formatUnits(request.quote.amountUnits > 0n ? request.quote.amountUnits : 0n, asset)}, but the listed price is ${formatUnits(listed, asset)}.`,
          request.quote.amountUnits,
          asset.code,
        )
      ).prepared;
    }
    const requirement = provider.validatePaymentRequirement({
      asset: asset.code,
      amountUnits: listed,
      recipient: authorizedRecipient,
    });
    if (!requirement.ok) {
      return (await block("asset_mismatch", requirement.reason, listed, asset.code)).prepared;
    }

    // 6. The per-purchase limit and the remaining budget.
    const budget = await getBudgetStatus(tx, engagement.id);
    if (!budget) return refuse("engagement_not_active", "The engagement has no mandate.");
    if (listed > budget.perTransactionUnits) {
      return (
        await block(
          "per_purchase_limit",
          `"${offering.name}" costs ${formatUnits(listed, asset)}, above the per-purchase limit of ${formatUnits(budget.perTransactionUnits, asset)}.`,
          listed,
          asset.code,
        )
      ).prepared;
    }
    if (listed > budget.remainingUnits) {
      const { purchase, prepared } = await block(
        "budget_exceeded",
        `"${offering.name}" costs ${formatUnits(listed, asset)}, but only ${formatUnits(budget.remainingUnits > 0n ? budget.remainingUnits : 0n, asset)} of the budget remains.`,
        listed,
        asset.code,
      );
      if (purchase && prepared.kind === "outcome" && prepared.outcome.status === "blocked") {
        await openApprovalRequest(tx, engagement, {
          kind: "budget_increase",
          purchase,
          budget,
          shortfallUnits: listed - budget.remainingUnits,
          explanation: request.explanation ?? "",
        });
        prepared.outcome.approvalRequested = true;
      }
      return prepared;
    }

    // 7. The wallet has funds that are not already promised to another payment.
    if (listed > budget.walletAvailableUnits) {
      const available = budget.walletAvailableUnits > 0n ? budget.walletAvailableUnits : 0n;
      const { purchase, prepared } = await block(
        "insufficient_wallet_funds",
        `"${offering.name}" costs ${formatUnits(listed, asset)}, but the engagement wallet has ${formatUnits(available, asset)} available. The budget allows it; the wallet needs funding.`,
        listed,
        asset.code,
      );
      if (purchase && prepared.kind === "outcome" && prepared.outcome.status === "blocked") {
        await openApprovalRequest(tx, engagement, {
          kind: "additional_funding",
          purchase,
          budget,
          shortfallUnits: listed - available,
          explanation: request.explanation ?? "",
        });
        prepared.outcome.approvalRequested = true;
      }
      return prepared;
    }

    // 8. Reserve the capacity and record the attempt, in the same transaction as the checks.
    const [purchase] = await tx
      .insert(purchases)
      .values({
        engagementId: engagement.id,
        agentRunId: request.agentRunId ?? null,
        serviceOfferingId: offering.id,
        offeringName: offering.name,
        quantity,
        asset: asset.code,
        amountUnits: listed,
        recipient: authorizedRecipient,
        idempotencyKey: request.idempotencyKey,
        status: "reserved",
        isSimulated: provider.simulated,
      })
      .returning();
    const [reservation] = await tx
      .insert(spendingReservations)
      .values({
        purchaseId: purchase.id,
        engagementId: engagement.id,
        mandateId: mandate.id,
        amountUnits: listed,
      })
      .returning();
    const [attempt] = await tx
      .insert(paymentAttempts)
      .values({
        purchaseId: purchase.id,
        reservationId: reservation.id,
        engagementId: engagement.id,
        engagementWalletId: wallet.id,
        rail: engagement.rail,
        asset: asset.code,
        amountUnits: listed,
        recipient: authorizedRecipient,
        provider: provider.name,
        idempotencyKey: request.idempotencyKey,
        isSimulated: provider.simulated,
      })
      .returning();
    return { kind: "pay", purchase, attempt, provider, walletRef: wallet.providerRef };
  });
}

type Settlement =
  | { status: "confirmed"; providerRef: string }
  | { status: "failed"; reason: string }
  | { status: "uncertain"; providerRef: string | null; reason: string };

/** Steps 9 and 10: pay through the provider, then verify independently. Nothing here is trusted until verified. */
async function pay(
  provider: PaymentProvider,
  attempt: PaymentAttempt,
  walletRef: string,
): Promise<Settlement> {
  let result: PaymentResult;
  try {
    result = await provider.initiatePayment({
      idempotencyKey: attempt.idempotencyKey,
      fromWalletRef: walletRef,
      asset: attempt.asset,
      amountUnits: attempt.amountUnits,
      recipient: attempt.recipient,
    });
  } catch {
    return { status: "uncertain", providerRef: null, reason: "The payment provider did not answer." };
  }
  if (result.status === "failed") return { status: "failed", reason: result.reason };
  return verify(provider, attempt, result.providerRef);
}

async function verify(
  provider: PaymentProvider,
  attempt: PaymentAttempt,
  providerRef: string,
): Promise<Settlement> {
  try {
    const verified = await provider.verifyPayment({
      providerRef,
      amountUnits: attempt.amountUnits,
      asset: attempt.asset,
      recipient: attempt.recipient,
    });
    return verified
      ? { status: "confirmed", providerRef }
      : { status: "uncertain", providerRef, reason: "The payment could not be verified." };
  } catch {
    return { status: "uncertain", providerRef, reason: "The payment could not be verified." };
  }
}

/** Step 11: record the outcome. Success is written only for a verified payment. */
async function settle(purchaseId: string, settlement: Settlement): Promise<Purchase> {
  return getDb().transaction(async (tx) => {
    const [purchase] = await tx.select().from(purchases).where(eq(purchases.id, purchaseId)).for("update");
    const [engagement] = await tx
      .select()
      .from(engagements)
      .where(eq(engagements.id, purchase.engagementId))
      .for("update");
    const [attempt] = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.purchaseId, purchase.id))
      .for("update");
    // Already settled by an earlier call: leave it exactly as it is.
    if (attempt.status === "succeeded" || attempt.status === "failed") return purchase;

    if (settlement.status === "failed") {
      await tx
        .update(paymentAttempts)
        .set({ status: "failed", failureReason: settlement.reason })
        .where(eq(paymentAttempts.id, attempt.id));
      await tx
        .update(spendingReservations)
        .set({ status: "released", settledAt: new Date() })
        .where(and(eq(spendingReservations.id, attempt.reservationId), eq(spendingReservations.status, "held")));
      const [failed] = await tx
        .update(purchases)
        .set({ status: "payment_failed", blockMessage: settlement.reason })
        .where(eq(purchases.id, purchase.id))
        .returning();
      await note(tx, engagement.id, purchase.agentRunId, "payment_failed", {
        service: purchase.offeringName,
        reason: settlement.reason,
      });
      await recordAudit(
        {
          actorUserId: null,
          organizationId: engagement.organizationId,
          action: "payment.failed",
          entityType: "purchase",
          entityId: purchase.id,
          metadata: { reason: settlement.reason, amountUnits: purchase.amountUnits.toString() },
        },
        tx,
      );
      return failed;
    }

    if (settlement.status === "uncertain") {
      // The reservation stays held, so the capacity cannot be spent twice.
      await tx
        .update(paymentAttempts)
        .set({ status: "uncertain", providerRef: settlement.providerRef, failureReason: settlement.reason })
        .where(eq(paymentAttempts.id, attempt.id));
      const [uncertain] = await tx
        .update(purchases)
        .set({ status: "needs_reconciliation", blockMessage: settlement.reason })
        .where(eq(purchases.id, purchase.id))
        .returning();
      await note(tx, engagement.id, purchase.agentRunId, "payment_uncertain", {
        service: purchase.offeringName,
        reason: settlement.reason,
      });
      await recordAudit(
        {
          actorUserId: null,
          organizationId: engagement.organizationId,
          action: "payment.uncertain",
          entityType: "purchase",
          entityId: purchase.id,
          metadata: { reason: settlement.reason },
        },
        tx,
      );
      return uncertain;
    }

    const [wallet] = await tx
      .select()
      .from(engagementWallets)
      .where(eq(engagementWallets.id, attempt.engagementWalletId))
      .for("update");
    const [debited] = await tx
      .update(engagementWallets)
      .set({ balanceUnits: sql`${engagementWallets.balanceUnits} - ${purchase.amountUnits.toString()}::numeric` })
      .where(eq(engagementWallets.id, wallet.id))
      .returning();
    await tx
      .update(paymentAttempts)
      .set({ status: "succeeded", providerRef: settlement.providerRef, failureReason: null })
      .where(eq(paymentAttempts.id, attempt.id));
    const [payment] = await tx
      .insert(paymentTransactions)
      .values({
        paymentAttemptId: attempt.id,
        purchaseId: purchase.id,
        engagementId: engagement.id,
        engagementWalletId: wallet.id,
        sellerProfileId: engagement.sellerProfileId!,
        rail: attempt.rail,
        asset: attempt.asset,
        amountUnits: attempt.amountUnits,
        recipient: attempt.recipient,
        provider: attempt.provider,
        providerRef: settlement.providerRef,
        isSimulated: attempt.isSimulated,
        verifiedAt: new Date(),
      })
      .returning();
    await tx.insert(walletLedgerEntries).values({
      organizationId: engagement.organizationId,
      rail: attempt.rail,
      engagementWalletId: wallet.id,
      kind: "payment_debit",
      deltaUnits: -purchase.amountUnits,
      balanceAfterUnits: debited.balanceUnits,
    });
    await tx
      .update(spendingReservations)
      .set({ status: "committed", settledAt: new Date() })
      .where(eq(spendingReservations.id, attempt.reservationId));
    const [paid] = await tx
      .update(purchases)
      .set({ status: "paid", blockMessage: null })
      .where(eq(purchases.id, purchase.id))
      .returning();
    await note(tx, engagement.id, purchase.agentRunId, "payment_confirmed", {
      service: purchase.offeringName,
      amount: formatUnits(purchase.amountUnits, { code: wallet.asset, decimals: wallet.assetDecimals }),
      reference: settlement.providerRef,
      simulated: attempt.isSimulated,
    });
    await recordAudit(
      {
        actorUserId: null,
        organizationId: engagement.organizationId,
        action: "payment.confirmed",
        entityType: "payment_transaction",
        entityId: payment.id,
        metadata: {
          engagementId: engagement.id,
          purchaseId: purchase.id,
          rail: attempt.rail,
          asset: attempt.asset,
          amountUnits: attempt.amountUnits.toString(),
          providerRef: settlement.providerRef,
          simulated: attempt.isSimulated,
        },
      },
      tx,
    );
    return paid;
  });
}

/** The one way a seller is ever paid. */
export async function executePurchase(request: PurchaseRequest): Promise<PurchaseOutcome> {
  const prepared = await prepare(request);
  if (prepared.kind === "outcome") return prepared.outcome;
  const settlement = await pay(prepared.provider, prepared.attempt, prepared.walletRef);
  return outcomeOf(await settle(prepared.purchase.id, settlement), false);
}

/** Store what the seller returned for a purchase that has been paid for. */
export async function recordDelivery(
  purchaseId: string,
  delivery: Record<string, unknown>,
): Promise<Purchase> {
  const [delivered] = await getDb()
    .update(purchases)
    .set({ status: "delivered", delivery })
    .where(and(eq(purchases.id, purchaseId), eq(purchases.status, "paid")))
    .returning();
  if (!delivered) throw conflict("Only a paid purchase can be delivered.");
  return delivered;
}

/**
 * Resolve a payment whose outcome was unknown by asking the provider what
 * happened. It never sends the payment again: it only learns the result and
 * records it. Until then the reservation stays held.
 */
export async function reconcilePurchase(actor: Actor | null, purchaseId: string): Promise<Purchase> {
  assertAuthenticated(actor);
  if (!isUuid(purchaseId)) throw notFound("Purchase");
  const [found] = await getDb().select().from(purchases).where(eq(purchases.id, purchaseId));
  if (!found) throw notFound("Purchase");

  const attempt = await withEngagement(actor, found.engagementId, "engagement.operate", async (tx) => {
    const [purchase] = await tx.select().from(purchases).where(eq(purchases.id, purchaseId));
    if (purchase.status !== "needs_reconciliation") {
      throw conflict("This purchase does not need reconciling.");
    }
    const [row] = await tx.select().from(paymentAttempts).where(eq(paymentAttempts.purchaseId, purchaseId));
    return row;
  });

  // The provider the attempt was made with: a real payment is never reconciled against the demo, or the reverse.
  const provider = getPaymentProvider(attempt.rail, attempt.isSimulated ? "simulated" : "goat_testnet3");
  let settlement: Settlement;
  try {
    const status = await provider.getPaymentStatus({
      idempotencyKey: attempt.idempotencyKey,
      providerRef: attempt.providerRef,
    });
    if (status.status === "succeeded") settlement = await verify(provider, attempt, status.providerRef);
    else if (status.status === "failed") settlement = { status: "failed", reason: status.reason };
    else settlement = { status: "uncertain", providerRef: attempt.providerRef, reason: "The provider still cannot say what happened." };
  } catch {
    settlement = { status: "uncertain", providerRef: attempt.providerRef, reason: "The payment provider did not answer." };
  }
  return settle(purchaseId, settlement);
}
