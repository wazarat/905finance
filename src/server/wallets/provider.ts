import type { PaymentRail } from "@/db/schema";
import type { AssetInfo } from "@/lib/units";

/**
 * Wallet management for one payment rail.
 *
 * A provider only talks to its rail's wallet infrastructure. It makes no
 * authorization decisions: every method here is called by the data layer
 * after a person's permission and the engagement's state have been checked,
 * and the platform's own records decide what is allowed.
 *
 * Wallet management is deliberately separate from payment execution (the
 * payment provider interface arrives with the purchasing agent). Providers are
 * rail-specific and are never substituted for one another.
 */
export interface WalletProvider {
  readonly rail: PaymentRail;
  /** Stored on every record this provider creates. */
  readonly name: string;
  /** True when no real asset or external system is involved. */
  readonly simulated: boolean;
  /** The asset this rail's accounts hold. */
  readonly asset: AssetInfo;

  /** Connect or create the buyer organization's master funding account on this rail. */
  connectMasterAccount(input: { organizationId: string }): Promise<{ providerRef: string }>;

  /** Create a new wallet for one engagement. Must return a reference never issued before. */
  provisionEngagementWallet(input: {
    engagementId: string;
    organizationId: string;
  }): Promise<{ providerRef: string }>;

  /**
   * The balance the rail itself reports, or null when the rail keeps no
   * independent balance and the platform ledger is the source of truth.
   */
  getBalance(input: { providerRef: string }): Promise<bigint | null>;

  /**
   * Move an already-authorized amount from the master account to an
   * engagement wallet. Called at most once per funding authorization.
   */
  executeFunding(input: {
    fundingAuthorizationId: string;
    idempotencyKey: string;
    fromProviderRef: string;
    toProviderRef: string;
    amountUnits: bigint;
  }): Promise<FundingResult>;

  /** Stop a wallet from being used for purchases. */
  suspendPurchasing(input: { providerRef: string }): Promise<void>;

  /** Sign or release one payment that the policy engine has already approved. */
  authorizePayment(input: {
    providerRef: string;
    recipient: string;
    amountUnits: bigint;
    idempotencyKey: string;
  }): Promise<{ providerRef: string }>;

  /** Return unused funds to the master account after a person authorizes it. */
  returnUnusedFunds(input: {
    fromProviderRef: string;
    toProviderRef: string;
    amountUnits: bigint;
    idempotencyKey: string;
  }): Promise<FundingResult>;
}

export type FundingResult =
  | { status: "executed"; providerRef: string }
  | { status: "failed"; reason: string };

/** Raised by a provider for an operation its rail does not offer yet. */
export class WalletOperationUnavailable extends Error {
  constructor(operation: string, rail: PaymentRail) {
    super(`${operation} is not available on the ${rail} rail yet.`);
    this.name = "WalletOperationUnavailable";
  }
}
