import "server-only";
import type { PaymentRail, Project, SellerProfile, ServiceOffering } from "@/db/schema";
import { offeringPriceUnits } from "../budget";
import { isAppError } from "../errors";
import { simulatedRecipient } from "../payments/registry";
import { enqueueTestingJob, fulfilmentBlocker } from "../testing/jobs";
import type { AssetInfo } from "@/lib/units";

/** A message from an engagement's agent to its seller. */
export type AgentToSeller =
  | { kind: "quote_request"; offeringId: string; quantity: number }
  | { kind: "delivery_request"; purchaseId: string; offeringId: string; paymentReference: string };

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
  | { kind: "delivery"; purchaseId: string; result: Record<string, unknown> }
  | { kind: "refusal"; reason: string };

/** How an agent's messages reach one seller's agent. */
export interface SellerTransport {
  /** Shown to the buyer so it is clear what is on the other end. */
  readonly description: string;
  readonly simulated: boolean;
  send(message: AgentToSeller): Promise<SellerReply>;
}

export type SellerTransportContext = {
  seller: Pick<SellerProfile, "id" | "displayName" | "isSample">;
  offerings: ServiceOffering[];
  /** The project the engagement is for. */
  project: Pick<Project, "sourceType" | "fixtureKey">;
  rail: PaymentRail;
  asset: AssetInfo;
};

/**
 * The controlled demo seller. It answers for the platform's sample listings
 * only, and the conversation with it happens inside the application.
 *
 * The testing it sells is real: a paid purchase becomes a job for the
 * platform's testing worker, which executes the test and reports what
 * happened. So that nobody pays for a test that cannot run, it declines to
 * quote unless a live worker can run that test type against the project.
 * It never states a result itself.
 */
export class DemoSellerTransport implements SellerTransport {
  readonly description =
    "Demo seller agent run by 905 Finance. Tests it sells are executed by the platform's testing worker.";
  readonly simulated = true;

  constructor(private readonly context: SellerTransportContext) {}

  async send(message: AgentToSeller): Promise<SellerReply> {
    const offering = this.context.offerings.find((o) => o.id === message.offeringId && o.isActive);
    if (!offering) return { kind: "refusal", reason: "That service is not on offer." };

    if (message.kind === "quote_request") {
      const price = offeringPriceUnits(offering, this.context.asset, message.quantity);
      if (price === null) return { kind: "refusal", reason: "That service cannot be priced." };
      const blocker = await fulfilmentBlocker(this.context.project, offering.capability);
      if (blocker) return { kind: "refusal", reason: blocker };
      return {
        kind: "quote",
        offeringId: offering.id,
        quantity: message.quantity,
        asset: this.context.asset.code,
        amountUnits: price.toString(),
        recipient: simulatedRecipient(this.context.rail, this.context.seller.id),
      };
    }

    try {
      // The job is built from the platform's own record of the purchase.
      const job = await enqueueTestingJob(message.purchaseId);
      return { kind: "accepted", purchaseId: message.purchaseId, jobId: job.id };
    } catch (error) {
      if (!isAppError(error)) console.error("Could not queue a testing job", error);
      return {
        kind: "refusal",
        reason: isAppError(error) ? error.message : "The test could not be queued.",
      };
    }
  }
}

type Resolver = (context: SellerTransportContext) => SellerTransport | null;

const defaultResolver: Resolver = (context) =>
  context.seller.isSample ? new DemoSellerTransport(context) : null;

let resolver: Resolver = defaultResolver;

/**
 * The transport for a seller, or null when the seller's agent cannot be
 * reached yet. Only the platform's sample sellers are connected for now,
 * through the demo seller; calling real seller endpoints comes later.
 */
export function resolveSellerTransport(context: SellerTransportContext): SellerTransport | null {
  return resolver(context);
}

/** Test hook: substitute how sellers are reached, or restore the default with undefined. */
export function setSellerTransportResolver(next: Resolver | undefined): void {
  resolver = next ?? defaultResolver;
}
