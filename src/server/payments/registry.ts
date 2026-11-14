import "server-only";
import type { PaymentRail } from "@/db/schema";
import { DemoPaymentProvider } from "./demo";
import type { PaymentProvider } from "./provider";

const providers = new Map<PaymentRail, PaymentProvider>();

/**
 * The payment provider for a rail. Both rails use the demo provider until the
 * Qatom and GOAT Flow integrations are built; each rail keeps its own instance.
 */
export function getPaymentProvider(rail: PaymentRail): PaymentProvider {
  let provider = providers.get(rail);
  if (!provider) {
    provider = new DemoPaymentProvider(rail);
    providers.set(rail, provider);
  }
  return provider;
}

/** Test hook: substitute a provider for one rail, or restore the default with undefined. */
export function setPaymentProvider(rail: PaymentRail, provider: PaymentProvider | undefined): void {
  if (provider) providers.set(rail, provider);
  else providers.delete(rail);
}

/** The simulated receiving account of a seller on a rail, used until real ones are connected. */
export function simulatedRecipient(rail: PaymentRail, sellerProfileId: string): string {
  return `sim-recipient:${rail}:${sellerProfileId}`;
}
