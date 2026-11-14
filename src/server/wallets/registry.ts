import "server-only";
import type { PaymentRail, Settlement } from "@/db/schema";
import { SETTLEMENT_RAIL } from "@/lib/capabilities";
import { conflict } from "../errors";
import { goatLiveConfig } from "../goat/live";
import { GoatWalletProvider } from "./goat";
import type { WalletProvider } from "./provider";
import { SimulatedWalletProvider } from "./simulated";

const simulated = new Map<PaymentRail, WalletProvider>();
const overrides = new Map<string, WalletProvider>();
let live: GoatWalletProvider | undefined;

/**
 * The settlement a new engagement gets: real GOAT Testnet3 when it is fully
 * configured, simulated otherwise. An existing engagement keeps the one it
 * was authorized with, whatever is configured later.
 */
export function currentSettlement(): Settlement {
  return goatLiveConfig() ? "goat_testnet3" : "simulated";
}

/**
 * The wallet provider for a rail and a settlement. Simulated and real
 * providers are never substituted for one another: an engagement authorized
 * as real has no simulated fallback, and the reverse.
 */
export function getWalletProvider(rail: PaymentRail, settlement: Settlement = "simulated"): WalletProvider {
  const override = overrides.get(`${rail}:${settlement}`);
  if (override) return override;
  if (settlement === "goat_testnet3") {
    const config = goatLiveConfig();
    if (rail !== SETTLEMENT_RAIL || !config) {
      throw conflict(
        "This engagement settles on GOAT Testnet3, which is not configured here, so its wallet cannot be used.",
      );
    }
    live ??= new GoatWalletProvider(config);
    return live;
  }
  let provider = simulated.get(rail);
  if (!provider) {
    provider = new SimulatedWalletProvider(rail);
    simulated.set(rail, provider);
  }
  return provider;
}

/** The real provider, with the operations only it has. */
export function getGoatWalletProvider(): GoatWalletProvider {
  return getWalletProvider(SETTLEMENT_RAIL, "goat_testnet3") as GoatWalletProvider;
}

/** Test hook: substitute a provider, or restore the default with undefined. */
export function setWalletProvider(
  rail: PaymentRail,
  provider: WalletProvider | undefined,
  settlement: Settlement = "simulated",
): void {
  if (provider) overrides.set(`${rail}:${settlement}`, provider);
  else overrides.delete(`${rail}:${settlement}`);
  if (settlement === "goat_testnet3") live = undefined;
}
