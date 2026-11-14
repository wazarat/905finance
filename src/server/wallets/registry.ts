import "server-only";
import type { PaymentRail } from "@/db/schema";
import type { WalletProvider } from "./provider";
import { SimulatedWalletProvider } from "./simulated";

const providers = new Map<PaymentRail, WalletProvider>();

/**
 * The wallet provider for a rail. Both rails are simulated until their real
 * integrations are built; each rail still gets its own provider instance and
 * its own accounts, so nothing is shared between them.
 */
export function getWalletProvider(rail: PaymentRail): WalletProvider {
  let provider = providers.get(rail);
  if (!provider) {
    provider = new SimulatedWalletProvider(rail);
    providers.set(rail, provider);
  }
  return provider;
}

/** Test hook: substitute a provider for one rail, or restore the default with undefined. */
export function setWalletProvider(rail: PaymentRail, provider: WalletProvider | undefined): void {
  if (provider) providers.set(rail, provider);
  else providers.delete(rail);
}
