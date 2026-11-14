import "server-only";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { getAddress, type Hash } from "viem";
import { z } from "zod";
import { getDb, schema, type Tx } from "@/db/client";
import type { Engagement, EngagementState, FundReturn, TestingJobStatus } from "@/db/schema";
import { SETTLEMENT_RAIL } from "@/lib/capabilities";
import { isTerminal } from "@/lib/engagement-state";
import { GOAT_TESTNET3, isEvmAddress, isTxHash } from "@/lib/goat";
import type { AssetInfo } from "@/lib/units";
import { recordAudit } from "./audit";
import { assertAuthenticated, isUuid, requirePermissionOnRecord, type Actor } from "./authz";
import { getBudgetStatus } from "./budget";
import { closeEngagement, withEngagement } from "./engagement-core";
import { conflict, notFound } from "./errors";
import { gasBalance, goatClient, tokenBalance, verifyTokenTransfer } from "./goat/chain";
import { goatLiveConfig } from "./goat/live";
import { goatSigner } from "./goat/signer";
import { goatFlowTiming } from "./payments/goat-flow";
import { parseInput } from "./validation";
import { ensureMasterAccount } from "./wallets";

const {
  engagements,
  engagementWallets,
  masterWalletAccounts,
  walletLedgerEntries,
  fundingAuthorizations,
  fundReturns,
  purchases,
  paymentTransactions,
  testingJobs,
  engagementEvents,
} = schema;

/**
 * Ending an engagement, and what happens to the money left in its wallet.
 *
 * When an engagement ends its agent loses all authority at once and its
 * wallet is frozen with whatever it holds. Nothing moves automatically, and
 * nothing ever moves to another engagement. The owner may then authorize
 * sending the unused funds back to the account they came from, once every
 * payment the engagement attempted is accounted for.
 */

/** The buyer declares the work done. Final, like cancelling, but says so. */
export async function completeEngagement(actor: Actor | null, engagementId: string): Promise<Engagement> {
  return withEngagement(actor, engagementId, "engagement.terminate", async (tx, engagement, who) => {
    if (engagement.state !== "ACTIVE" && engagement.state !== "PAUSED_FOR_APPROVAL") {
      throw conflict(
        isTerminal(engagement.state)
          ? "This engagement has already ended."
          : "Only an engagement that has started can be completed. Cancel it instead.",
      );
    }
    return closeEngagement(tx, engagement, "COMPLETED", who.userId, "Completed by the buyer.");
  });
}

const returnInput = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/, "Reload the page and try again."),
  confirmed: z.literal(true, { error: "Confirm that you authorize returning these funds." }),
});

/** Gas a token transfer needs, as a ceiling. */
const TRANSFER_GAS = 120_000n;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Take the amount out of the wallet's record, close the wallet, and mark the return done. */
async function applyReturn(tx: Tx, record: FundReturn, actorUserId: string): Promise<FundReturn> {
  const amountSql = sql`${record.amountUnits.toString()}::numeric`;
  const [engagement] = await tx.select().from(engagements).where(eq(engagements.id, record.engagementId));
  const [wallet] = await tx
    .update(engagementWallets)
    .set({ balanceUnits: sql`${engagementWallets.balanceUnits} - ${amountSql}`, status: "closed" })
    .where(eq(engagementWallets.id, record.engagementWalletId))
    .returning();
  await tx.insert(walletLedgerEntries).values({
    organizationId: engagement.organizationId,
    rail: wallet.rail,
    engagementWalletId: wallet.id,
    kind: "return_debit",
    deltaUnits: -record.amountUnits,
    balanceAfterUnits: wallet.balanceUnits,
    actorUserId,
  });
  // A simulated master account is the platform's own record, so it is credited
  // here. The buyer's real wallet is the buyer's own: the chain is its record.
  if (record.isSimulated) {
    const [master] = await tx
      .update(masterWalletAccounts)
      .set({ balanceUnits: sql`${masterWalletAccounts.balanceUnits} + ${amountSql}` })
      .where(eq(masterWalletAccounts.id, record.masterWalletAccountId))
      .returning();
    await tx.insert(walletLedgerEntries).values({
      organizationId: engagement.organizationId,
      rail: wallet.rail,
      masterWalletAccountId: master.id,
      kind: "return_credit",
      deltaUnits: record.amountUnits,
      balanceAfterUnits: master.balanceUnits,
      actorUserId,
    });
  }
  const [executed] = await tx
    .update(fundReturns)
    .set({ status: "executed", executedAt: new Date(), failureReason: null })
    .where(eq(fundReturns.id, record.id))
    .returning();
  await recordAudit(
    {
      actorUserId,
      organizationId: engagement.organizationId,
      action: "funds.returned",
      entityType: "fund_return",
      entityId: record.id,
      metadata: {
        engagementId: engagement.id,
        asset: record.asset,
        amountUnits: record.amountUnits.toString(),
        simulated: record.isSimulated,
        reference: executed.providerRef,
      },
    },
    tx,
  );
  return executed;
}

async function setReturn(id: string, values: Partial<FundReturn>): Promise<FundReturn> {
  const [row] = await getDb().update(fundReturns).set(values).where(eq(fundReturns.id, id)).returning();
  return row;
}

/**
 * The owner authorizes returning an ended engagement's unused funds to the
 * account that funded it. The whole unused amount goes back, to that one
 * account, and nowhere else.
 */
export async function returnUnusedFunds(
  actor: Actor | null,
  engagementId: string,
  rawInput: unknown,
): Promise<FundReturn> {
  const input = parseInput(returnInput, rawInput);

  const prepared = await withEngagement(actor, engagementId, "engagement.fund", async (tx, engagement, who) => {
    const [earlier] = await tx.select().from(fundReturns).where(eq(fundReturns.idempotencyKey, input.idempotencyKey));
    if (earlier) {
      if (earlier.engagementId !== engagement.id) throw conflict("Reload the page and try again.");
      return { record: earlier, replayed: true as const };
    }
    if (!isTerminal(engagement.state) || !engagement.rail) {
      throw conflict("Funds can be returned only after the engagement has ended.");
    }
    const [wallet] = await tx
      .select()
      .from(engagementWallets)
      .where(eq(engagementWallets.engagementId, engagement.id))
      .for("update");
    if (!wallet || wallet.status !== "closing" || wallet.balanceUnits <= 0n) {
      throw conflict("This engagement has no unused funds to return.");
    }
    // Every payment must be accounted for first: a payment still in doubt may yet take funds.
    const [open] = await tx
      .select({ id: purchases.id })
      .from(purchases)
      .where(
        and(
          eq(purchases.engagementId, engagement.id),
          inArray(purchases.status, ["reserved", "needs_reconciliation"]),
        ),
      );
    if (open) {
      throw conflict("A payment's outcome is still unknown. Reconcile it before returning funds.");
    }
    const [live] = await tx
      .select({ id: fundReturns.id })
      .from(fundReturns)
      .where(and(eq(fundReturns.engagementId, engagement.id), ne(fundReturns.status, "failed")));
    if (live) throw conflict("A return of these funds is already under way.");

    // Back to where it came from: the simulated master account, or the buyer's own funding wallet.
    let master;
    if (wallet.isSimulated) {
      master = await ensureMasterAccount(tx, engagement.organizationId, engagement.rail);
    } else {
      [master] = await tx
        .select()
        .from(masterWalletAccounts)
        .where(
          and(
            eq(masterWalletAccounts.organizationId, engagement.organizationId),
            eq(masterWalletAccounts.rail, SETTLEMENT_RAIL),
            eq(masterWalletAccounts.isSimulated, false),
          ),
        );
      if (!master) throw conflict("There is no funding wallet on record to return these funds to.");
    }

    const [record] = await tx
      .insert(fundReturns)
      .values({
        engagementId: engagement.id,
        engagementWalletId: wallet.id,
        masterWalletAccountId: master.id,
        asset: wallet.asset,
        amountUnits: wallet.balanceUnits,
        idempotencyKey: input.idempotencyKey,
        isSimulated: wallet.isSimulated,
        authorizedBy: who.userId,
      })
      .returning();
    if (wallet.isSimulated) {
      return { record: await applyReturn(tx, record, who.userId), replayed: true as const };
    }
    return {
      record,
      replayed: false as const,
      userId: who.userId,
      from: wallet.providerRef,
      custodyRef: wallet.custodyRef,
      to: master.providerRef,
    };
  });
  if (prepared.replayed) return prepared.record;

  // A real return: the engagement's wallet sends the tokens back on the chain.
  const { record, userId, from, to, custodyRef } = prepared;
  const config = goatLiveConfig();
  if (!config || !custodyRef || !isEvmAddress(from) || !isEvmAddress(to)) {
    return setReturn(record.id, {
      status: "failed",
      failureReason: "GOAT Testnet3 settlement is not configured here, so the wallet cannot send. Nothing moved.",
    });
  }
  try {
    if ((await tokenBalance(config.token.address, from)) < record.amountUnits) {
      return setReturn(record.id, {
        status: "failed",
        failureReason: "The wallet does not hold this amount on the chain. Nothing was sent.",
      });
    }
    if ((await gasBalance(from)) < (await goatClient().getGasPrice()) * TRANSFER_GAS) {
      return setReturn(record.id, {
        status: "failed",
        failureReason: `The wallet has no ${GOAT_TESTNET3.nativeCurrency.symbol} to pay the network fee. Send it a little, then try again. Nothing was sent.`,
      });
    }
  } catch {
    return setReturn(record.id, {
      status: "failed",
      failureReason: "GOAT Network could not be read just now. Nothing was sent; try again shortly.",
    });
  }

  let hash: Hash;
  try {
    hash = await goatSigner(config).sendTokenTransfer({
      walletId: custodyRef,
      from: getAddress(from),
      token: config.token.address,
      to: getAddress(to),
      amountUnits: record.amountUnits,
    });
  } catch (error) {
    console.error("A fund return could not be confirmed as sent", error);
    return setReturn(record.id, {
      status: "uncertain",
      failureReason: "The transfer may or may not have been broadcast. It has not been sent again.",
    });
  }
  // Saved before waiting, so the transaction can always be found again.
  const sent = await setReturn(record.id, { status: "sent", providerRef: hash });
  try {
    return await settleReturn(record.id, userId, true);
  } catch (error) {
    // The transfer is out and its hash is saved. Confirming it can wait for "Check again".
    console.error("A fund return was sent but could not be confirmed yet", error);
    return sent;
  }
}

/** Look at the chain for a return that was sent, and record what happened. */
async function settleReturn(returnId: string, actorUserId: string, wait: boolean): Promise<FundReturn> {
  const db = getDb();
  const [record] = await db.select().from(fundReturns).where(eq(fundReturns.id, returnId));
  const config = goatLiveConfig();
  if (record.status !== "sent" || !isTxHash(record.providerRef) || !config) return record;
  const [wallet] = await db.select().from(engagementWallets).where(eq(engagementWallets.id, record.engagementWalletId));
  const [master] = await db
    .select()
    .from(masterWalletAccounts)
    .where(eq(masterWalletAccounts.id, record.masterWalletAccountId));

  const deadline = Date.now() + (wait ? goatFlowTiming.chainWaitMs : 0);
  for (;;) {
    const result = await verifyTokenTransfer({
      hash: record.providerRef,
      token: config.token.address,
      from: getAddress(wallet.providerRef),
      to: getAddress(master.providerRef),
      amountUnits: record.amountUnits,
    });
    if (result.ok) {
      return db.transaction(async (tx) => {
        const [fresh] = await tx.select().from(fundReturns).where(eq(fundReturns.id, returnId)).for("update");
        return fresh.status === "sent" ? applyReturn(tx, fresh, actorUserId) : fresh;
      });
    }
    if (!result.pending) return setReturn(record.id, { status: "failed", failureReason: result.reason });
    if (Date.now() >= deadline) return record;
    await sleep(goatFlowTiming.pollMs);
  }
}

/** The owner asks again about a return that was sent but not yet confirmed. Sends nothing. */
export async function checkFundReturn(actor: Actor | null, engagementId: string): Promise<FundReturn | null> {
  assertAuthenticated(actor);
  if (!isUuid(engagementId)) throw notFound("Engagement");
  const db = getDb();
  const [engagement] = await db.select().from(engagements).where(eq(engagements.id, engagementId));
  await requirePermissionOnRecord(actor, engagement, "engagement.fund", "Engagement");
  const [record] = await db
    .select()
    .from(fundReturns)
    .where(and(eq(fundReturns.engagementId, engagement.id), eq(fundReturns.status, "sent")));
  if (!record) return null;
  try {
    return await settleReturn(record.id, actor.userId, false);
  } catch {
    throw conflict("GOAT Network could not be read just now. Try again shortly.");
  }
}

// ---------------------------------------------------------------------------
// The final record
// ---------------------------------------------------------------------------

export type EngagementStatement = {
  engagementId: string;
  state: EngagementState;
  closedAt: Date | null;
  asset: AssetInfo;
  isSimulated: boolean;
  /** Everything a person authorized into the wallet. */
  fundedUnits: bigint;
  /** Confirmed payments to the seller. */
  spentUnits: bigint;
  /** Set aside for payments whose outcome is not settled yet. */
  reservedUnits: bigint;
  /** Sent back to the account that funded it. */
  returnedUnits: bigint;
  /** Still in the wallet. */
  heldUnits: bigint;
  /** True when funded = spent + returned + held, to the unit. */
  reconciles: boolean;
  /** Purchases whose outcome a person still has to settle. */
  unresolved: number;
  fundings: Array<{ id: string; amountUnits: bigint; reference: string | null; at: Date }>;
  payments: Array<{
    id: string;
    purchaseId: string;
    service: string;
    amountUnits: bigint;
    recipient: string;
    reference: string;
    at: Date;
  }>;
  returns: Array<{
    id: string;
    amountUnits: bigint;
    status: string;
    reference: string | null;
    note: string | null;
    at: Date;
  }>;
  tests: Record<TestingJobStatus, number>;
  /** What the owner may do next about the unused funds. */
  canReturn: boolean;
  returnBlockedBy: string | null;
  history: Array<{ at: Date; state: EngagementState; note: string }>;
};

/** The complete financial record of one engagement, from the platform's own books. */
export async function getEngagementStatement(
  actor: Actor | null,
  engagementId: string,
): Promise<EngagementStatement | null> {
  assertAuthenticated(actor);
  if (!isUuid(engagementId)) throw notFound("Engagement");
  const db = getDb();
  const [engagement] = await db.select().from(engagements).where(eq(engagements.id, engagementId));
  await requirePermissionOnRecord(actor, engagement, "engagement.view", "Engagement");
  const [wallet] = await db.select().from(engagementWallets).where(eq(engagementWallets.engagementId, engagement.id));
  const budget = await getBudgetStatus(db, engagement.id);
  if (!wallet || !budget) return null;

  const fundings = await db
    .select()
    .from(fundingAuthorizations)
    .where(and(eq(fundingAuthorizations.engagementId, engagement.id), eq(fundingAuthorizations.status, "executed")))
    .orderBy(asc(fundingAuthorizations.authorizedAt));
  const payments = await db
    .select({ payment: paymentTransactions, service: purchases.offeringName })
    .from(paymentTransactions)
    .innerJoin(purchases, eq(purchases.id, paymentTransactions.purchaseId))
    .where(eq(paymentTransactions.engagementId, engagement.id))
    .orderBy(asc(paymentTransactions.sequence));
  const returns = await db
    .select()
    .from(fundReturns)
    .where(eq(fundReturns.engagementId, engagement.id))
    .orderBy(asc(fundReturns.authorizedAt));
  const jobRows = await db
    .select({ status: testingJobs.status, total: sql<number>`count(*)::int` })
    .from(testingJobs)
    .where(eq(testingJobs.engagementId, engagement.id))
    .groupBy(testingJobs.status);
  const [open] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(purchases)
    .where(
      and(eq(purchases.engagementId, engagement.id), inArray(purchases.status, ["reserved", "needs_reconciliation"])),
    );
  const events = await db
    .select()
    .from(engagementEvents)
    .where(eq(engagementEvents.engagementId, engagement.id))
    .orderBy(asc(engagementEvents.sequence));

  const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);
  const fundedUnits = sum(fundings.map((f) => f.amountUnits));
  const returnedUnits = sum(returns.filter((r) => r.status === "executed").map((r) => r.amountUnits));
  const tests: EngagementStatement["tests"] = { queued: 0, running: 0, completed: 0, failed: 0 };
  for (const row of jobRows) tests[row.status] = row.total;
  const unresolved = open?.total ?? 0;
  const liveReturn = returns.find((r) => r.status !== "failed" && r.status !== "executed");

  const returnBlockedBy = !isTerminal(engagement.state)
    ? "The engagement has not ended."
    : wallet.balanceUnits <= 0n
      ? null
      : unresolved > 0
        ? "A payment's outcome is still unknown. Reconcile it first."
        : liveReturn
          ? liveReturn.status === "sent"
            ? "A return has been sent and is waiting for the chain to confirm it."
            : "A return was attempted and its outcome is unknown. It needs checking by hand before another is sent."
          : null;

  return {
    engagementId: engagement.id,
    state: engagement.state,
    closedAt: engagement.closedAt,
    asset: budget.asset,
    isSimulated: wallet.isSimulated,
    fundedUnits,
    spentUnits: budget.spentUnits,
    reservedUnits: budget.reservedUnits,
    returnedUnits,
    heldUnits: wallet.balanceUnits,
    reconciles: fundedUnits === budget.spentUnits + returnedUnits + wallet.balanceUnits,
    unresolved,
    fundings: fundings.map((f) => ({
      id: f.id,
      amountUnits: f.amountUnits,
      reference: f.isSimulated ? null : f.providerRef,
      at: f.authorizedAt,
    })),
    payments: payments.map(({ payment, service }) => ({
      id: payment.id,
      purchaseId: payment.purchaseId,
      service,
      amountUnits: payment.amountUnits,
      recipient: payment.recipient,
      reference: payment.providerRef,
      at: payment.createdAt,
    })),
    returns: returns.map((r) => ({
      id: r.id,
      amountUnits: r.amountUnits,
      status: r.status,
      reference: r.providerRef,
      note: r.failureReason,
      at: r.authorizedAt,
    })),
    tests,
    canReturn: isTerminal(engagement.state) && wallet.balanceUnits > 0n && returnBlockedBy === null,
    returnBlockedBy,
    history: events.map((event) => ({ at: event.createdAt, state: event.toState, note: event.note ?? "" })),
  };
}
