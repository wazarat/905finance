import "server-only";
import { GoatFlowClient } from "goatflow-sdk-server";
import { GOAT_TESTNET3 } from "@/lib/goat";
import type { GoatLiveConfig } from "./live";

/**
 * GOAT Flow, as far as this application uses it: create an order for one
 * payment, read what became of it, and cancel one that was never paid.
 * Requests are signed by GOAT's own server SDK with the merchant's
 * credentials, which stay on the server.
 */

export const FLOW_SETTLED = ["PAYMENT_CONFIRMED", "INVOICED"] as const;
export const FLOW_DEAD = ["FAILED", "EXPIRED", "CANCELLED"] as const;

export type FlowOrder = {
  orderId: string;
  /** How GOAT Flow expects to be paid. Only a direct token transfer is supported here. */
  flow: string;
  tokenContract: string;
  payToAddress: string;
  chainId: number;
  amountUnits: bigint;
  /** Unix seconds. */
  expiresAt: number;
};

export type FlowOrderState = { status: string; transactionHash: string | null };

export interface GoatFlow {
  createOrder(input: {
    dappOrderId: string;
    fromAddress: string;
    amountUnits: bigint;
  }): Promise<FlowOrder>;
  getOrder(orderId: string): Promise<FlowOrderState>;
  cancelOrder(orderId: string): Promise<void>;
}

export class GoatFlowApi implements GoatFlow {
  private readonly client: GoatFlowClient;

  constructor(private readonly config: GoatLiveConfig) {
    this.client = new GoatFlowClient({
      baseUrl: config.flow.apiUrl,
      apiKey: config.flow.apiKey,
      apiSecret: config.flow.apiSecret,
    });
  }

  async createOrder(input: { dappOrderId: string; fromAddress: string; amountUnits: bigint }): Promise<FlowOrder> {
    const order = await this.client.createOrder({
      dappOrderId: input.dappOrderId,
      chainId: GOAT_TESTNET3.id,
      tokenSymbol: this.config.token.symbol,
      tokenContract: this.config.token.address,
      fromAddress: input.fromAddress,
      amountWei: input.amountUnits.toString(),
    });
    return {
      orderId: order.orderId,
      flow: order.flow,
      tokenContract: order.tokenContract,
      payToAddress: order.payToAddress,
      chainId: order.fromChainId,
      amountUnits: BigInt(order.amountWei),
      expiresAt: order.expiresAt,
    };
  }

  async getOrder(orderId: string): Promise<FlowOrderState> {
    const order = await this.client.getOrderStatus(orderId, { timeoutMs: 15_000 });
    return { status: order.status, transactionHash: order.txHash ?? null };
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.client.cancelOrder(orderId);
  }
}

let api: GoatFlow | undefined;
let override: GoatFlow | undefined;

export function goatFlow(config: GoatLiveConfig): GoatFlow {
  if (override) return override;
  api ??= new GoatFlowApi(config);
  return api;
}

/** Test hook: stand in for GOAT Flow, or restore it with undefined. */
export function setGoatFlow(next: GoatFlow | undefined): void {
  override = next;
}
