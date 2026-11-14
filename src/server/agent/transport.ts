import "server-only";
import type { DbOrTx } from "@/db/client";
import type { PaymentRail, Project, SellerProfile, ServiceOffering } from "@/db/schema";
import { qatomItemFor } from "../qatom/config";
import { hasUsableQatomConnection } from "../qatom/connection";
import { QatomSellerTransport } from "../qatom/transport";
import { answerAsSampleSeller } from "../seller-agent/service";
import type { AssetInfo } from "@/lib/units";

/** A message from an engagement's agent to its seller. */
export type AgentToSeller =
  | { kind: "quote_request"; offeringId: string; quantity: number }
  | { kind: "delivery_request"; purchaseId: string; offeringId: string; paymentReference: string }
  /** Ask how an order the seller accepted is going. */
  | { kind: "status_request"; purchaseId: string };

/** What a seller sends back. Everything in it is treated as untrusted data. */
export type SellerReply =
  | {
      kind: "quote";
      offeringId: string;
      quantity: number;
      asset: string;
      /** Decimal string of the asset's smallest unit. */
      amountUnits: string;
      recipient: string;
      note?: string;
    }
  /** The seller has taken the paid work on. Results follow when the work is done. */
  | { kind: "accepted"; purchaseId: string; jobId: string }
  | {
      kind: "status";
      purchaseId: string;
      jobId: string;
      state: "queued" | "running" | "completed" | "failed";
      summary?: string;
    }
  | { kind: "delivery"; purchaseId: string; result: Record<string, unknown> }
  | { kind: "refusal"; reason: string };

/** How an agent's messages reach one seller's agent. */
export interface SellerTransport {
  /** Shown to the buyer so it is clear what is on the other end. */
  readonly description: string;
  /** True when the carrying of messages is a stand-in rather than a real network. */
  readonly simulated: boolean;
  /** What carries the messages. Defaults to the in-app channel. */
  readonly channel?: "in_app" | "qatom";
  send(message: AgentToSeller): Promise<SellerReply>;
  /** The carrier's own reference for the message just sent, if it gives one. */
  takeReference?(): string | null;
}

export type SellerTransportContext = {
  /** The engagement the conversation belongs to. */
  engagementId: string;
  /** The buying organization, whose Qatom account carries the messages when it is linked. */
  organizationId: string;
  seller: Pick<SellerProfile, "id" | "slug" | "displayName" | "isSample">;
  offerings: ServiceOffering[];
  /** The project the engagement is for. */
  project: Pick<Project, "sourceType" | "fixtureKey">;
  rail: PaymentRail;
  asset: AssetInfo;
  /** The transaction the caller is in, if any, so that lookups here join it rather than wait on it. */
  db?: DbOrTx;
};

/**
 * The in-app channel to the platform's sample sellers. The conversation
 * never leaves the application: a message is handed straight to the sample
 * seller's agent, which checks it against the platform's records exactly as
 * it would a message arriving from outside.
 *
 * The testing it sells is real: an accepted order becomes a job for the
 * testing worker. Only the carrying of messages is a stand-in.
 */
export class DemoSellerTransport implements SellerTransport {
  readonly description =
    "In-app demo channel to a sample seller run by 905 Finance. Tests it sells are executed by the platform's testing worker.";
  readonly simulated = true;

  constructor(private readonly context: SellerTransportContext) {}

  async send(message: AgentToSeller): Promise<SellerReply> {
    return answerAsSampleSeller(this.context.engagementId, message);
  }
}

type Resolver = (
  context: SellerTransportContext,
) => SellerTransport | null | Promise<SellerTransport | null>;

/**
 * Qatom carries the conversation when both ends are ready for it: the seller
 * has a Qatom catalog item, and the buying organization has linked its Qatom
 * account. Otherwise a sample seller is reached over the in-app channel, and
 * any other seller cannot be reached at all.
 */
const defaultResolver: Resolver = async (context) => {
  const catalogItemId = qatomItemFor(context.seller.slug);
  if (catalogItemId !== null && (await hasUsableQatomConnection(context.organizationId, context.db))) {
    return new QatomSellerTransport({
      engagementId: context.engagementId,
      organizationId: context.organizationId,
      catalogItemId,
    });
  }
  return context.seller.isSample ? new DemoSellerTransport(context) : null;
};

let resolver: Resolver = defaultResolver;

/** The channel to a seller, or null when the seller's agent cannot be reached. */
export async function resolveSellerTransport(context: SellerTransportContext): Promise<SellerTransport | null> {
  return resolver(context);
}

/** Test hook: substitute how sellers are reached, or restore the default with undefined. */
export function setSellerTransportResolver(next: Resolver | undefined): void {
  resolver = next ?? defaultResolver;
}
