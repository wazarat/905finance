/**
 * GOAT Network, as this application uses it: seller identity (ERC-8004) and
 * payment. Testnet3 only. Nothing here can point the application at a
 * network where assets have real value.
 *
 * Values are GOAT's published ones (docs.goat.network, "Networks and RPC"
 * and "ERC-8004: Agent Registry").
 */

export const GOAT_TESTNET3 = {
  id: 48816,
  name: "GOAT Testnet3",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrl: "https://rpc.testnet3.goat.network",
  explorerUrl: "https://explorer.testnet3.goat.network",
  faucetUrl: "https://bridge.testnet3.goat.network/faucet",
} as const;

/** The ERC-8004 registries on Testnet3. */
export const ERC8004_TESTNET3 = {
  identityRegistry: "0x54B8d8E2455946f2A5B8982283f2359812e815ce",
  reputationRegistry: "0xd9140951d8aE6E5F625a02F5908535e16e3af964",
} as const;

/** How ERC-8004 names a registry: the chain and the registry contract together. */
export const ERC8004_AGENT_REGISTRY = `eip155:${GOAT_TESTNET3.id}:${ERC8004_TESTNET3.identityRegistry}`;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export function isEvmAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && ADDRESS.test(value);
}

export function isTxHash(value: unknown): value is `0x${string}` {
  return typeof value === "string" && TX_HASH.test(value);
}

/** The explorer page for an address or a transaction, or null for anything that is neither. */
export function explorerLink(value: string | null | undefined): string | null {
  if (isEvmAddress(value)) return `${GOAT_TESTNET3.explorerUrl}/address/${value}`;
  if (isTxHash(value)) return `${GOAT_TESTNET3.explorerUrl}/tx/${value}`;
  return null;
}

/** The explorer page for a registered agent's identity token. */
export function agentExplorerLink(agentId: string): string {
  return `${GOAT_TESTNET3.explorerUrl}/token/${ERC8004_TESTNET3.identityRegistry}/instance/${agentId}`;
}

/** `0x1234…abcd`, for places too narrow for a whole address. */
export function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/**
 * A reference as people see it. One kept in the platform's own ledger is
 * shown by its id, without the prefix it is stored under.
 */
export function displayReference(value: string): string {
  const internal = /^(?:demo-payment|sim-[a-z]+):[a-z]+:(.+)$/.exec(value);
  return internal ? `ledger:${internal[1]}` : value;
}
