import "server-only";
import {
  createPublicClient,
  defineChain,
  erc20Abi,
  getAddress,
  http,
  isAddressEqual,
  parseEventLogs,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import { GOAT_TESTNET3 } from "@/lib/goat";

/**
 * Read access to GOAT Testnet3. Everything here only reads the chain: there
 * is no key in this module and nothing in it can send a transaction.
 */

export const goatTestnet3 = defineChain({
  id: GOAT_TESTNET3.id,
  name: GOAT_TESTNET3.name,
  nativeCurrency: GOAT_TESTNET3.nativeCurrency,
  rpcUrls: { default: { http: [GOAT_TESTNET3.rpcUrl] } },
  blockExplorers: { default: { name: "GOAT Testnet3 Explorer", url: GOAT_TESTNET3.explorerUrl } },
  testnet: true,
});

/** How many blocks must follow a transaction before it is treated as settled. */
export const SETTLED_CONFIRMATIONS = 2n;

let client: PublicClient | undefined;
let chainChecked = false;

/**
 * The RPC endpoint to use. `GOAT_RPC_URL` may name a dedicated Testnet3
 * endpoint; whatever it names is asked for its chain id before it is trusted.
 */
function rpcUrl(): string {
  const configured = process.env.GOAT_RPC_URL?.trim();
  return configured && /^https:\/\//.test(configured) ? configured : GOAT_TESTNET3.rpcUrl;
}

export function goatClient(): PublicClient {
  client ??= createPublicClient({
    chain: goatTestnet3,
    transport: http(rpcUrl(), { timeout: 15_000, retryCount: 2 }),
  }) as PublicClient;
  return client;
}

/**
 * Test hook: substitute the chain client, or restore the real one with
 * undefined. A substitute is taken to be Testnet3 unless told otherwise.
 */
export function setGoatClient(next: PublicClient | undefined, options: { checked?: boolean } = {}): void {
  client = next;
  chainChecked = next !== undefined && options.checked !== false;
}

/**
 * Refuse to proceed unless the endpoint really is Testnet3. A misconfigured
 * endpoint must never lead the application to treat another network's
 * records, least of all a mainnet's, as its own.
 */
export async function assertTestnet3(): Promise<void> {
  if (chainChecked) return;
  const id = await goatClient().getChainId();
  if (id !== GOAT_TESTNET3.id) {
    throw new Error(`The GOAT endpoint reports chain ${id}, not Testnet3 (${GOAT_TESTNET3.id}).`);
  }
  chainChecked = true;
}

export type TokenInfo = { address: Address; symbol: string; decimals: number };

/** A token's own account of itself, read from its contract. */
export async function readToken(address: Address): Promise<TokenInfo> {
  await assertTestnet3();
  const [symbol, decimals] = await Promise.all([
    goatClient().readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    goatClient().readContract({ address, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { address: getAddress(address), symbol, decimals };
}

export async function tokenBalance(token: Address, holder: Address): Promise<bigint> {
  await assertTestnet3();
  return goatClient().readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
}

/** The holder's balance of the native asset, which pays for gas. */
export async function gasBalance(holder: Address): Promise<bigint> {
  await assertTestnet3();
  return goatClient().getBalance({ address: holder });
}

export type TransferCheck =
  | { ok: true; blockNumber: bigint; confirmations: bigint }
  | { ok: false; pending: boolean; reason: string };

/**
 * Confirm, from the chain itself, that a transaction moved exactly the
 * expected amount of the expected token from one address to another, and
 * has enough blocks on top of it. Nothing about the transaction is taken on
 * anyone's word: only its receipt and its logs are read.
 */
export async function verifyTokenTransfer(expected: {
  hash: Hash;
  token: Address;
  from: Address;
  to: Address;
  amountUnits: bigint;
}): Promise<TransferCheck> {
  await assertTestnet3();
  const chain = goatClient();
  let receipt;
  try {
    receipt = await chain.getTransactionReceipt({ hash: expected.hash });
  } catch {
    return { ok: false, pending: true, reason: "The transaction is not on the chain yet." };
  }
  if (receipt.status !== "success") {
    return { ok: false, pending: false, reason: "The transaction failed on the chain." };
  }
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs }).filter(
    (log) => isAddressEqual(log.address, expected.token),
  );
  const match = transfers.find(
    (log) =>
      isAddressEqual(log.args.from, expected.from) &&
      isAddressEqual(log.args.to, expected.to) &&
      log.args.value === expected.amountUnits,
  );
  if (!match) {
    return {
      ok: false,
      pending: false,
      reason: "The transaction does not contain a transfer of that amount, in that token, between those addresses.",
    };
  }
  const head = await chain.getBlockNumber();
  const confirmations = head - receipt.blockNumber + 1n;
  if (confirmations < SETTLED_CONFIRMATIONS) {
    return { ok: false, pending: true, reason: "The transaction is waiting for more blocks." };
  }
  return { ok: true, blockNumber: receipt.blockNumber, confirmations };
}
