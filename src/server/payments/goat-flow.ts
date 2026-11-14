import "server-only";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getAddress, isAddressEqual, type Address, type Hash } from "viem";
import { GoatFlowError } from "goatflow-sdk-server";
import { getDb, schema } from "@/db/client";
import type { GoatFlowOrder, PaymentRail } from "@/db/schema";
import { GOAT_TESTNET3, isEvmAddress, isTxHash } from "@/lib/goat";
import { gasBalance, goatClient, tokenBalance, verifyTokenTransfer } from "../goat/chain";
import { FLOW_DEAD, FLOW_SETTLED, goatFlow } from "../goat/flow";
import { assertTokenMatchesChain, type GoatLiveConfig } from "../goat/live";
import { goatSigner } from "../goat/signer";
import type {
  PaymentProvider,
  PaymentRequest,
  PaymentRequirement,
  PaymentResult,
  PaymentStatus,
  RequirementCheck,
} from "./provider";

const { goatFlowOrders, engagementWallets } = schema;

/**
 * Payments on GOAT Testnet3 through GOAT Flow.
 *
 * One payment is one GOAT Flow order and one token transfer from the
 * engagement's wallet to the address the order names. Each step is written
 * down before it is taken, so that an attempt interrupted anywhere can be
 * found again and resolved, never repeated:
 *
 *   creating  the order is about to be requested
 *   payable   GOAT Flow issued the order; nothing has been sent
 *   sending   the transfer is about to be signed and broadcast
 *   sent      the transfer was broadcast; its hash is saved
 *   confirmed the chain shows the exact transfer, with blocks on top
 *   failed    nothing was paid
 *
 * A step whose outcome is not known (a timeout creating the order, an error
 * while broadcasting) is reported as unknown. It is never retried here: the
 * policy engine holds the reservation and a person reconciles it.
 */

/** How long to wait for the chain, and for GOAT Flow to notice. Shortened in tests. */
export const goatFlowTiming = { pollMs: 2_000, chainWaitMs: 60_000, flowWaitMs: 15_000 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A rough ceiling on what one token transfer costs in gas. */
const TRANSFER_GAS = 120_000n;

class OutcomeUnknown extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeUnknown";
  }
}

export class GoatFlowPaymentProvider implements PaymentProvider {
  readonly rail: PaymentRail = "goat";
  readonly name = "goat-flow";
  readonly simulated = false;

  constructor(private readonly config: GoatLiveConfig) {}

  validatePaymentRequirement(requirement: PaymentRequirement): RequirementCheck {
    if (requirement.asset !== this.config.token.symbol) {
      return { ok: false, reason: `Payments here are made in ${this.config.token.symbol}, not ${requirement.asset}.` };
    }
    if (requirement.amountUnits <= 0n) return { ok: false, reason: "The amount must be greater than zero." };
    if (!isEvmAddress(requirement.recipient)) {
      return { ok: false, reason: "The recipient is not an address on GOAT Network." };
    }
    return { ok: true };
  }

  private async save(id: string, values: Partial<GoatFlowOrder>): Promise<GoatFlowOrder> {
    const [row] = await getDb()
      .update(goatFlowOrders)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(goatFlowOrders.id, id))
      .returning();
    return row;
  }

  private fail(order: GoatFlowOrder, reason: string): Promise<PaymentResult> {
    return this.save(order.id, { status: "failed", failureReason: reason }).then(() => ({
      status: "failed" as const,
      reason,
    }));
  }

  async initiatePayment(request: PaymentRequest): Promise<PaymentResult> {
    const check = this.validatePaymentRequirement(request);
    if (!check.ok) return { status: "failed", reason: check.reason };
    if (!isEvmAddress(request.fromWalletRef)) {
      return { status: "failed", reason: "The engagement's wallet is not a GOAT Network wallet." };
    }
    await assertTokenMatchesChain(this.config);
    const token = this.config.token.address;
    const from = getAddress(request.fromWalletRef);
    const recipient = getAddress(request.recipient);

    // Claim the attempt. Only the caller that creates the row may create the order.
    const dappOrderId = `905-${createHash("sha256").update(request.idempotencyKey).digest("hex").slice(0, 40)}`;
    const [created] = await getDb()
      .insert(goatFlowOrders)
      .values({
        idempotencyKey: request.idempotencyKey,
        dappOrderId,
        tokenContract: token,
        fromAddress: from,
        amountUnits: request.amountUnits,
      })
      .onConflictDoNothing()
      .returning();
    let order =
      created ??
      (await getDb().select().from(goatFlowOrders).where(eq(goatFlowOrders.idempotencyKey, request.idempotencyKey)))[0];

    if (!created) {
      // A repeat of an attempt already under way: report where it stands, and take no new step
      // unless the next step is one that certainly has not been taken.
      if (order.status === "confirmed" && order.transactionHash) {
        return { status: "succeeded", providerRef: order.transactionHash };
      }
      if (order.status === "failed") return { status: "failed", reason: order.failureReason ?? "The payment failed." };
      if (order.status === "sent" && order.transactionHash) return this.confirm(order, recipient);
      if (order.status !== "payable") {
        throw new OutcomeUnknown("An earlier attempt at this payment has an unknown outcome.");
      }
    } else {
      try {
        const issued = await goatFlow(this.config).createOrder({
          dappOrderId,
          fromAddress: from,
          amountUnits: request.amountUnits,
        });
        order = await this.save(order.id, {
          orderId: issued.orderId,
          payToAddress: issued.payToAddress,
          flowStatus: "CHECKOUT_VERIFIED",
          status: "payable",
        });
        // GOAT Flow's terms must be exactly the ones that were approved.
        const problem =
          issued.flow !== "ERC20_DIRECT"
            ? "GOAT Flow asked for a payment method this application does not use."
            : issued.chainId !== GOAT_TESTNET3.id
              ? "GOAT Flow issued the order for another network."
              : !isEvmAddress(issued.tokenContract) || !isAddressEqual(issued.tokenContract, token)
                ? "GOAT Flow issued the order in another token."
                : issued.amountUnits !== request.amountUnits
                  ? "GOAT Flow issued the order for a different amount."
                  : !isEvmAddress(issued.payToAddress) || !isAddressEqual(issued.payToAddress, recipient)
                    ? "GOAT Flow would pay an address other than the seller's verified wallet."
                    : null;
        if (problem) return this.abandon(order, `${problem} Nothing was sent.`);
      } catch (error) {
        // A refusal means no order exists. Anything else, and one may.
        if (error instanceof GoatFlowError && error.status && error.status >= 400 && error.status < 500) {
          return this.fail(order, `GOAT Flow declined the order: ${error.message.slice(0, 200)}`);
        }
        await this.save(order.id, { status: "creation_unknown" });
        throw new OutcomeUnknown("GOAT Flow did not confirm whether the order was created.");
      }
    }

    // Nothing has been sent yet. Check the wallet can pay before trying.
    const [wallet] = await getDb()
      .select({ custodyRef: engagementWallets.custodyRef })
      .from(engagementWallets)
      .where(eq(engagementWallets.providerRef, from));
    if (!wallet?.custodyRef) return this.abandon(order, "The engagement's wallet cannot sign. Nothing was sent.");
    if ((await tokenBalance(token, from)) < request.amountUnits) {
      return this.abandon(order, `The engagement's wallet does not hold enough ${this.config.token.symbol} on the chain. Nothing was sent.`);
    }
    const gasNeeded = (await goatClient().getGasPrice()) * TRANSFER_GAS;
    if ((await gasBalance(from)) < gasNeeded) {
      return this.abandon(
        order,
        `The engagement's wallet has no ${GOAT_TESTNET3.nativeCurrency.symbol} to pay the network fee. Nothing was sent.`,
      );
    }

    order = await this.save(order.id, { status: "sending" });
    let hash: Hash;
    try {
      hash = await goatSigner(this.config).sendTokenTransfer({
        walletId: wallet.custodyRef,
        from,
        token,
        to: recipient,
        amountUnits: request.amountUnits,
      });
    } catch (error) {
      console.error("GOAT transfer could not be confirmed as sent", error);
      throw new OutcomeUnknown("The transfer may or may not have been broadcast.");
    }
    // Saved before waiting on it, so the transaction can always be found again.
    order = await this.save(order.id, { status: "sent", transactionHash: hash });
    return this.confirm(order, recipient);
  }

  /** Cancel an order nothing was sent for, and record why. */
  private async abandon(order: GoatFlowOrder, reason: string): Promise<PaymentResult> {
    if (order.orderId) {
      await goatFlow(this.config)
        .cancelOrder(order.orderId)
        .catch(() => undefined);
    }
    return this.fail(order, reason);
  }

  private check(order: GoatFlowOrder, recipient: Address) {
    return verifyTokenTransfer({
      hash: order.transactionHash as Hash,
      token: this.config.token.address,
      from: getAddress(order.fromAddress),
      to: recipient,
      amountUnits: order.amountUnits,
    });
  }

  /** Wait for the chain to show the transfer, then note what GOAT Flow says about the order. */
  private async confirm(order: GoatFlowOrder, recipient: Address): Promise<PaymentResult> {
    const deadline = Date.now() + goatFlowTiming.chainWaitMs;
    for (;;) {
      const result = await this.check(order, recipient);
      if (result.ok) break;
      if (!result.pending) return this.fail(order, result.reason);
      if (Date.now() >= deadline) throw new OutcomeUnknown("The transfer has not been confirmed on the chain yet.");
      await sleep(goatFlowTiming.pollMs);
    }
    await this.save(order.id, { status: "confirmed", flowStatus: await this.flowStatus(order, true) });
    return { status: "succeeded", providerRef: order.transactionHash as string };
  }

  /** GOAT Flow's view of the order, for the record. The chain, not this, decides whether a payment happened. */
  private async flowStatus(order: GoatFlowOrder, wait: boolean): Promise<string | null> {
    if (!order.orderId) return order.flowStatus;
    const deadline = Date.now() + (wait ? goatFlowTiming.flowWaitMs : 0);
    let status = order.flowStatus;
    for (;;) {
      try {
        status = (await goatFlow(this.config).getOrder(order.orderId)).status;
      } catch {
        return status;
      }
      const settled = (FLOW_SETTLED as readonly string[]).includes(status) || (FLOW_DEAD as readonly string[]).includes(status);
      if (settled || Date.now() >= deadline) return status;
      await sleep(goatFlowTiming.pollMs);
    }
  }

  async getPaymentStatus({ idempotencyKey }: { idempotencyKey: string }): Promise<PaymentStatus> {
    const [order] = await getDb()
      .select()
      .from(goatFlowOrders)
      .where(eq(goatFlowOrders.idempotencyKey, idempotencyKey));
    if (!order) return { status: "unknown" };
    if (order.status === "confirmed" && order.transactionHash) {
      return { status: "succeeded", providerRef: order.transactionHash };
    }
    if (order.status === "failed") return { status: "failed", reason: order.failureReason ?? "The payment failed." };

    // A hash we saved, or one GOAT Flow saw for an order whose broadcast we lost track of.
    let hash = order.transactionHash;
    if (!hash && order.orderId) {
      try {
        const seen = await goatFlow(this.config).getOrder(order.orderId);
        await this.save(order.id, { flowStatus: seen.status });
        if (isTxHash(seen.transactionHash)) hash = seen.transactionHash;
        // Never sent, and the order can no longer be paid: nothing happened.
        else if (order.status === "payable" && (FLOW_DEAD as readonly string[]).includes(seen.status)) {
          await this.save(order.id, { status: "failed", failureReason: "The order lapsed before anything was sent." });
          return { status: "failed", reason: "The order lapsed before anything was sent." };
        }
      } catch {
        return { status: "unknown" };
      }
    }
    if (!hash || !order.payToAddress || !isEvmAddress(order.payToAddress)) return { status: "unknown" };

    const result = await this.check({ ...order, transactionHash: hash }, getAddress(order.payToAddress));
    if (result.ok) {
      await this.save(order.id, { status: "confirmed", transactionHash: hash });
      return { status: "succeeded", providerRef: hash };
    }
    if (result.pending) return { status: "unknown" };
    await this.save(order.id, { status: "failed", failureReason: result.reason, transactionHash: hash });
    return { status: "failed", reason: result.reason };
  }

  async verifyPayment(input: {
    providerRef: string;
    amountUnits: bigint;
    asset: string;
    recipient: string;
  }): Promise<boolean> {
    if (input.asset !== this.config.token.symbol || !isTxHash(input.providerRef) || !isEvmAddress(input.recipient)) {
      return false;
    }
    const [order] = await getDb()
      .select()
      .from(goatFlowOrders)
      .where(eq(goatFlowOrders.transactionHash, input.providerRef));
    if (!order || order.amountUnits !== input.amountUnits) return false;
    // Independent of everything recorded above: read the chain again.
    const result = await verifyTokenTransfer({
      hash: input.providerRef,
      token: this.config.token.address,
      from: getAddress(order.fromAddress),
      to: getAddress(input.recipient),
      amountUnits: input.amountUnits,
    });
    return result.ok;
  }
}
