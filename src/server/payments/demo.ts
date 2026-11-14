import type { PaymentRail } from "@/db/schema";
import { getRail } from "@/lib/capabilities";
import type {
  PaymentProvider,
  PaymentRequest,
  PaymentRequirement,
  PaymentResult,
  PaymentStatus,
  RequirementCheck,
} from "./provider";

/**
 * A payment provider that moves nothing. It accepts a payment that is on its
 * rail and addressed to a simulated recipient, and remembers it by idempotency
 * key so the same request always gets the same answer. The platform ledger
 * records the simulated debit; no account or chain is involved.
 */
export class DemoPaymentProvider implements PaymentProvider {
  readonly name = "demo";
  readonly simulated = true;
  private readonly asset: string;
  private readonly settled = new Map<string, PaymentRequest & { providerRef: string }>();

  constructor(readonly rail: PaymentRail) {
    const definition = getRail(rail);
    if (!definition) throw new Error(`Unknown rail: ${rail}`);
    this.asset = definition.simulatedAsset.code;
  }

  validatePaymentRequirement(requirement: PaymentRequirement): RequirementCheck {
    if (requirement.asset !== this.asset) {
      return { ok: false, reason: `This rail settles in ${this.asset}, not ${requirement.asset}.` };
    }
    if (requirement.amountUnits <= 0n) {
      return { ok: false, reason: "The amount must be greater than zero." };
    }
    if (!requirement.recipient.startsWith(`sim-recipient:${this.rail}:`)) {
      return { ok: false, reason: "The recipient is not a simulated account on this rail." };
    }
    return { ok: true };
  }

  async initiatePayment(request: PaymentRequest): Promise<PaymentResult> {
    const check = this.validatePaymentRequirement(request);
    if (!check.ok) return { status: "failed", reason: check.reason };
    const existing = this.settled.get(request.idempotencyKey);
    if (existing) return { status: "succeeded", providerRef: existing.providerRef };
    const providerRef = `demo-payment:${this.rail}:${request.idempotencyKey}`;
    this.settled.set(request.idempotencyKey, { ...request, providerRef });
    return { status: "succeeded", providerRef };
  }

  async getPaymentStatus({ idempotencyKey }: { idempotencyKey: string }): Promise<PaymentStatus> {
    const existing = this.settled.get(idempotencyKey);
    return existing ? { status: "succeeded", providerRef: existing.providerRef } : { status: "unknown" };
  }

  async verifyPayment(input: {
    providerRef: string;
    amountUnits: bigint;
    asset: string;
    recipient: string;
  }): Promise<boolean> {
    for (const payment of this.settled.values()) {
      if (payment.providerRef === input.providerRef) {
        return (
          payment.amountUnits === input.amountUnits &&
          payment.asset === input.asset &&
          payment.recipient === input.recipient
        );
      }
    }
    return false;
  }
}
