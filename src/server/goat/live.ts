import "server-only";
import { getAddress, type Address } from "viem";
import { GOAT_TESTNET3, isEvmAddress } from "@/lib/goat";
import { privyServerConfig, type PrivyServerConfig } from "../env";
import { readToken } from "./chain";

/**
 * Whether real GOAT Testnet3 settlement is switched on, and with what.
 *
 * It is off unless every piece is configured and `GOAT_SETTLEMENT` says
 * `testnet3` in so many words, so that adding one credential can never turn
 * simulated engagements into real ones by accident. Only the Testnet3
 * payment API is accepted: there is no way to point this at a network where
 * the asset has value.
 */
export type GoatLiveConfig = {
  token: { address: Address; symbol: string; decimals: number };
  flow: { apiUrl: string; apiKey: string; apiSecret: string; merchantId: string };
  privy: PrivyServerConfig;
  /** A Privy policy to attach to every engagement wallet, restricting what it may sign. */
  walletPolicyId: string | null;
};

const FLOW_TESTNET_HOST = "flow-api.testnet3.goat.network";

/** What is still missing before real settlement can be switched on, for an operator. */
export function goatLiveGaps(): string[] {
  const env = process.env;
  const gaps: string[] = [];
  if (env.GOAT_SETTLEMENT !== "testnet3") gaps.push('GOAT_SETTLEMENT is not "testnet3"');
  if (!isEvmAddress(env.GOAT_USD_TOKEN_ADDRESS)) gaps.push("GOAT_USD_TOKEN_ADDRESS (the USD token contract)");
  if (!/^[A-Za-z0-9.]{1,12}$/.test(env.GOAT_USD_TOKEN_SYMBOL ?? "")) gaps.push("GOAT_USD_TOKEN_SYMBOL");
  if (!/^(?:[0-9]|1[0-8])$/.test(env.GOAT_USD_TOKEN_DECIMALS ?? "")) gaps.push("GOAT_USD_TOKEN_DECIMALS");
  let host = "";
  try {
    const url = new URL(env.GOATX402_API_URL ?? "");
    if (url.protocol === "https:") host = url.host;
  } catch {
    // Reported below.
  }
  if (host !== FLOW_TESTNET_HOST) gaps.push(`GOATX402_API_URL must be https://${FLOW_TESTNET_HOST}`);
  for (const key of ["GOATX402_API_KEY", "GOATX402_API_SECRET", "GOATX402_MERCHANT_ID"] as const) {
    if (!env[key]) gaps.push(key);
  }
  if (!privyServerConfig()) gaps.push("NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET");
  return gaps;
}

export function goatLiveConfig(): GoatLiveConfig | null {
  if (goatLiveGaps().length > 0) return null;
  const env = process.env;
  return {
    token: {
      address: getAddress(env.GOAT_USD_TOKEN_ADDRESS as string),
      symbol: env.GOAT_USD_TOKEN_SYMBOL as string,
      decimals: Number(env.GOAT_USD_TOKEN_DECIMALS),
    },
    flow: {
      apiUrl: `https://${FLOW_TESTNET_HOST}`,
      apiKey: env.GOATX402_API_KEY as string,
      apiSecret: env.GOATX402_API_SECRET as string,
      merchantId: env.GOATX402_MERCHANT_ID as string,
    },
    privy: privyServerConfig() as PrivyServerConfig,
    walletPolicyId: env.PRIVY_WALLET_POLICY_ID?.trim() || null,
  };
}

let tokenChecked: string | null = null;

/**
 * Confirm the configured token is what its contract says it is. Amounts are
 * exact integers of the token's smallest unit, so a wrong decimals setting
 * would misstate every figure; this refuses to proceed rather than risk it.
 */
export async function assertTokenMatchesChain(config: GoatLiveConfig): Promise<void> {
  const key = `${config.token.address}:${config.token.symbol}:${config.token.decimals}`;
  if (tokenChecked === key) return;
  const onChain = await readToken(config.token.address);
  // GOAT Flow's name for a token can differ in case from the contract's own
  // (TUSDT and tUSDT), so the names are compared without regard to case.
  if (
    onChain.decimals !== config.token.decimals ||
    onChain.symbol.toLowerCase() !== config.token.symbol.toLowerCase()
  ) {
    throw new Error(
      `The configured token is ${config.token.symbol} with ${config.token.decimals} decimals, but its contract on ${GOAT_TESTNET3.name} says ${onChain.symbol} with ${onChain.decimals}.`,
    );
  }
  tokenChecked = key;
}

/** Test hook: forget that the token was checked. */
export function resetGoatLiveChecks(): void {
  tokenChecked = null;
}
