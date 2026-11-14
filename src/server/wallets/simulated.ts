import { randomBytes } from "node:crypto";
import type { PaymentRail } from "@/db/schema";
import { getRail } from "@/lib/capabilities";
import type { AssetInfo } from "@/lib/units";
import { WalletOperationUnavailable, type FundingResult, type WalletProvider } from "./provider";

/**
 * A wallet provider with nothing behind it: no chain, no account, no asset.
 * It issues references and acknowledges transfers so the engagement and
 * funding flows can be exercised end to end, while the platform ledger holds
 * the simulated balances. Everything it creates is flagged as simulated.
 *
 * References are deliberately not shaped like real addresses or twin ids, so
 * a simulated wallet can never be mistaken for a real one.
 */
export class SimulatedWalletProvider implements WalletProvider {
  readonly name = "simulated";
  readonly simulated = true;
  readonly asset: AssetInfo;

  constructor(readonly rail: PaymentRail) {
    const definition = getRail(rail);
    if (!definition) throw new Error(`Unknown rail: ${rail}`);
    this.asset = { ...definition.simulatedAsset };
  }

  async connectMasterAccount({ organizationId }: { organizationId: string }) {
    return { providerRef: `sim-master:${this.rail}:${organizationId}` };
  }

  async provisionEngagementWallet() {
    // Random, so two engagements can never receive the same wallet reference.
    return { providerRef: `sim-wallet:${this.rail}:${randomBytes(16).toString("hex")}` };
  }

  async getBalance(): Promise<bigint | null> {
    return null;
  }

  async executeFunding(input: {
    fundingAuthorizationId: string;
    fromProviderRef: string;
    toProviderRef: string;
  }): Promise<FundingResult> {
    const prefix = `:${this.rail}:`;
    if (!input.fromProviderRef.includes(prefix) || !input.toProviderRef.includes(prefix)) {
      return { status: "failed", reason: "Source and destination are not on this rail." };
    }
    return { status: "executed", providerRef: `sim-funding:${this.rail}:${input.fundingAuthorizationId}` };
  }

  async suspendPurchasing(): Promise<void> {
    // Nothing external to revoke: the platform's wallet status is what blocks purchases.
  }

  async authorizePayment(): Promise<{ providerRef: string }> {
    throw new WalletOperationUnavailable("Payment authorization", this.rail);
  }

  async returnUnusedFunds(): Promise<FundingResult> {
    throw new WalletOperationUnavailable("Returning unused funds", this.rail);
  }
}
