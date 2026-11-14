import "server-only";
import type { PaymentRail, Settlement } from "@/db/schema";
import { SETTLEMENT_RAIL } from "@/lib/capabilities";
import { conflict } from "../errors";
import { goatLiveConfig } from "../goat/live";
import { DemoPaymentProvider } from "./demo";
import { GoatFlowPaymentProvider } from "./goat-flow";
import type { PaymentProvider } from "./provider";

const demo = new Map<PaymentRail, PaymentProvider>();
const overrides = new Map<string, PaymentProvider>();
let live: GoatFlowPaymentProvider | undefined;

/**
 * The payment provider for a rail and a settlement: GOAT Flow for an
 * engagement authorized as real, the demo provider for a simulated one. A
 * failed payment is never retried through the other.
 */
export function getPaymentProvider(rail: PaymentRail, settlement: Settlement = "simulated"): PaymentProvider {
  const override = overrides.get(`${rail}:${settlement}`);
  if (override) return override;
  if (settlement === "goat_testnet3") {
    const config = goatLiveConfig();
    if (rail !== SETTLEMENT_RAIL || !config) {
      throw conflict("This engagement settles on GOAT Testnet3, which is not configured here, so it cannot pay.");
    }
    live ??= new GoatFlowPaymentProvider(config);
    return live;
  }
  let provider = demo.get(rail);
  if (!provider) {
    provider = new DemoPaymentProvider(rail);
    demo.set(rail, provider);
  }
  return provider;
}

/** Test hook: substitute a provider, or restore the default with undefined. */
export function setPaymentProvider(
  rail: PaymentRail,
  provider: PaymentProvider | undefined,
  settlement: Settlement = "simulated",
): void {
  if (provider) overrides.set(`${rail}:${settlement}`, provider);
  else overrides.delete(`${rail}:${settlement}`);
  if (settlement === "goat_testnet3") live = undefined;
}

/** The simulated receiving account of a seller on a rail, used by simulated engagements only. */
export function simulatedRecipient(rail: PaymentRail, sellerProfileId: string): string {
  return `sim-recipient:${rail}:${sellerProfileId}`;
}
