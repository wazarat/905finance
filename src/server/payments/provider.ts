import type { PaymentRail } from "@/db/schema";

/**
 * Payment execution for one rail.
 *
 * A provider only moves value and reports what happened. It decides nothing:
 * every call is made by the policy engine after the engagement, seller,
 * recipient, service, amount, budget and balance have all been checked and
 * spending capacity has been reserved.
 *
 * Providers are rail-specific. A purchase is paid through exactly one
 * provider and is never retried through another.
 */
export interface PaymentProvider {
  readonly rail: PaymentRail;
  readonly name: string;
  /** True when no real value moves. */
  readonly simulated: boolean;

  /** Whether a seller's stated payment terms are ones this rail can settle. */
  validatePaymentRequirement(requirement: PaymentRequirement): RequirementCheck;

  /**
   * Start one payment. Must be safe to call again with the same idempotency
   * key without paying twice. Throwing means the outcome is unknown.
   */
  initiatePayment(request: PaymentRequest): Promise<PaymentResult>;

  /** The provider's current view of a payment it was asked to make. */
  getPaymentStatus(input: { idempotencyKey: string; providerRef?: string | null }): Promise<PaymentStatus>;

  /**
   * Independently confirm that a payment settled for the expected amount to
   * the expected recipient. Success is recorded only when this returns true.
   */
  verifyPayment(input: {
    providerRef: string;
    amountUnits: bigint;
    asset: string;
    recipient: string;
  }): Promise<boolean>;
}

export type PaymentRequirement = { asset: string; amountUnits: bigint; recipient: string };

export type RequirementCheck = { ok: true } | { ok: false; reason: string };

export type PaymentRequest = PaymentRequirement & {
  idempotencyKey: string;
  /** The engagement wallet being drawn on. */
  fromWalletRef: string;
};

export type PaymentResult =
  | { status: "succeeded"; providerRef: string }
  | { status: "failed"; reason: string };

export type PaymentStatus =
  | { status: "succeeded"; providerRef: string }
  | { status: "failed"; reason: string }
  | { status: "unknown" };
