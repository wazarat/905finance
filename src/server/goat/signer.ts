import "server-only";
import { PrivyClient } from "@privy-io/node";
import { createViemAccount } from "@privy-io/node/viem";
import { createWalletClient, erc20Abi, getAddress, http, type Address, type Hash } from "viem";
import { goatTestnet3 } from "./chain";
import { REPUTATION_REGISTRY, feedbackAbi } from "./erc8004";
import type { GoatLiveConfig } from "./live";

/**
 * The only place a key is ever used.
 *
 * Engagement wallets are created and held by Privy. This application never
 * has a private key: it asks Privy to sign one of two specific transactions, a
 * token transfer or a rating of an agent, and broadcasts the signed
 * transaction itself. Nothing here is reachable from a language model, a
 * testing worker, or the browser. A transfer is sent only by the payment
 * provider, after the policy engine has approved the exact amount and
 * recipient; a rating only after a person has given it.
 */
export interface GoatSigner {
  /** Create a new wallet for one engagement. The same external id never yields a second wallet. */
  createWallet(input: { externalId: string }): Promise<{ id: string; address: Address }>;
  /** Sign and broadcast one ERC-20 transfer from an engagement wallet. Returns the transaction hash. */
  sendTokenTransfer(input: {
    walletId: string;
    from: Address;
    token: Address;
    to: Address;
    amountUnits: bigint;
  }): Promise<Hash>;
  /**
   * Sign and broadcast one rating of an agent, from an engagement wallet to
   * the Reputation Registry. Moves no asset. Returns the transaction hash.
   */
  sendFeedback(input: FeedbackTransaction): Promise<Hash>;
}

export type FeedbackTransaction = {
  walletId: string;
  from: Address;
  agentId: bigint;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackUri: string;
  feedbackHash: Hash;
};

export class PrivyGoatSigner implements GoatSigner {
  private readonly client: PrivyClient;

  constructor(private readonly config: GoatLiveConfig) {
    this.client = new PrivyClient({ appId: config.privy.appId, appSecret: config.privy.appSecret });
  }

  async createWallet({ externalId }: { externalId: string }) {
    const wallet = await this.client.wallets().create({
      chain_type: "ethereum",
      external_id: externalId,
      display_name: `905 Finance ${externalId}`,
      ...(this.config.walletPolicyId ? { policy_ids: [this.config.walletPolicyId] } : {}),
      // Asking again for the same engagement returns the same wallet rather than a second one.
      idempotency_key: externalId,
    });
    return { id: wallet.id, address: getAddress(wallet.address) };
  }

  async sendTokenTransfer(input: {
    walletId: string;
    from: Address;
    token: Address;
    to: Address;
    amountUnits: bigint;
  }): Promise<Hash> {
    const account = createViemAccount(this.client, { walletId: input.walletId, address: input.from });
    const wallet = createWalletClient({
      account,
      chain: goatTestnet3,
      transport: http(goatTestnet3.rpcUrls.default.http[0], { timeout: 20_000 }),
    });
    // The chain is fixed to Testnet3 here, and the transaction is a transfer
    // of the one configured token: no native asset, no other contract.
    return wallet.writeContract({
      address: input.token,
      abi: erc20Abi,
      functionName: "transfer",
      args: [input.to, input.amountUnits],
    });
  }

  async sendFeedback(input: FeedbackTransaction): Promise<Hash> {
    const account = createViemAccount(this.client, { walletId: input.walletId, address: input.from });
    const wallet = createWalletClient({
      account,
      chain: goatTestnet3,
      transport: http(goatTestnet3.rpcUrls.default.http[0], { timeout: 20_000 }),
    });
    // One call to the Reputation Registry on Testnet3, carrying no value.
    return wallet.writeContract({
      address: REPUTATION_REGISTRY,
      abi: feedbackAbi,
      functionName: "giveFeedback",
      args: [
        input.agentId,
        input.value,
        input.valueDecimals,
        input.tag1,
        input.tag2,
        input.endpoint,
        input.feedbackUri,
        input.feedbackHash,
      ],
    });
  }
}

let signer: GoatSigner | undefined;
let override: GoatSigner | undefined;

export function goatSigner(config: GoatLiveConfig): GoatSigner {
  if (override) return override;
  signer ??= new PrivyGoatSigner(config);
  return signer;
}

/** Test hook: stand in for Privy, or restore it with undefined. */
export function setGoatSigner(next: GoatSigner | undefined): void {
  override = next;
}
