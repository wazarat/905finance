import "server-only";
import { erc20Abi, getAddress, isAddressEqual, parseEventLogs, type Address, type Hash } from "viem";
import type { PaymentRail } from "@/db/schema";
import { isEvmAddress } from "@/lib/goat";
import type { AssetInfo } from "@/lib/units";
import { SETTLED_CONFIRMATIONS, assertTestnet3, gasBalance, goatClient, tokenBalance } from "../goat/chain";
import { assertTokenMatchesChain, type GoatLiveConfig } from "../goat/live";
import { goatSigner } from "../goat/signer";
import { WalletOperationUnavailable, type FundingResult, type WalletProvider } from "./provider";

/**
 * Real wallets on GOAT Testnet3.
 *
 * An engagement's wallet is created and held by Privy; its reference is its
 * address. The buyer's master funding wallet is the buyer's own: the platform
 * never holds it and cannot move anything out of it. Funding is therefore
 * not something this provider does. The buyer sends the transfer from their
 * own wallet, and the provider's part is to confirm, from the chain, that
 * the transfer happened exactly as authorized.
 */
export class GoatWalletProvider implements WalletProvider {
  readonly rail: PaymentRail = "goat";
  readonly name = "privy-goat-testnet3";
  readonly simulated = false;
  readonly asset: AssetInfo;

  constructor(private readonly config: GoatLiveConfig) {
    this.asset = { code: config.token.symbol, decimals: config.token.decimals };
  }

  async connectMasterAccount(): Promise<{ providerRef: string }> {
    throw new WalletOperationUnavailable("Connecting a master account", this.rail);
  }

  async provisionEngagementWallet({ engagementId }: { engagementId: string }) {
    await assertTokenMatchesChain(this.config);
    const wallet = await goatSigner(this.config).createWallet({ externalId: `eng-${engagementId}` });
    return { providerRef: wallet.address, custodyRef: wallet.id };
  }

  async getBalance({ providerRef }: { providerRef: string }): Promise<bigint | null> {
    if (!isEvmAddress(providerRef)) return null;
    return tokenBalance(this.config.token.address, providerRef);
  }

  /** The wallet's balance of the native asset, which it needs to pay network fees. */
  async getGasBalance(providerRef: string): Promise<bigint | null> {
    return isEvmAddress(providerRef) ? gasBalance(providerRef) : null;
  }

  async executeFunding(): Promise<FundingResult> {
    // The platform cannot move the buyer's funds. See confirmFundingTransfer.
    return { status: "failed", reason: "Funding is sent from your own wallet, not by the platform." };
  }

  /**
   * Find, in one transaction, a transfer of exactly this amount of the
   * configured token into an engagement wallet, and report who sent it.
   */
  async confirmFundingTransfer(input: {
    hash: Hash;
    to: Address;
    amountUnits: bigint;
  }): Promise<{ ok: true; from: Address } | { ok: false; pending: boolean; reason: string }> {
    await assertTestnet3();
    await assertTokenMatchesChain(this.config);
    const chain = goatClient();
    let receipt;
    try {
      receipt = await chain.getTransactionReceipt({ hash: input.hash });
    } catch {
      return { ok: false, pending: true, reason: "That transaction is not on GOAT Testnet3 yet." };
    }
    if (receipt.status !== "success") {
      return { ok: false, pending: false, reason: "That transaction failed on the chain, so nothing arrived." };
    }
    const match = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs }).find(
      (log) =>
        isAddressEqual(log.address, this.config.token.address) &&
        isAddressEqual(log.args.to, input.to) &&
        log.args.value === input.amountUnits,
    );
    if (!match) {
      return {
        ok: false,
        pending: false,
        reason: `That transaction does not send exactly this amount of ${this.config.token.symbol} to this engagement's wallet.`,
      };
    }
    const confirmations = (await chain.getBlockNumber()) - receipt.blockNumber + 1n;
    if (confirmations < SETTLED_CONFIRMATIONS) {
      return { ok: false, pending: true, reason: "That transaction is waiting for one more block. Try again in a few seconds." };
    }
    return { ok: true, from: getAddress(match.args.from) };
  }

  async suspendPurchasing(): Promise<void> {
    // The platform's own record stops the wallet being used. Its funds stay
    // where they are until a person authorizes their return.
  }

  async authorizePayment(): Promise<{ providerRef: string }> {
    throw new WalletOperationUnavailable("Paying outside the payment provider", this.rail);
  }

  async returnUnusedFunds(): Promise<FundingResult> {
    throw new WalletOperationUnavailable("Returning unused funds", this.rail);
  }
}
