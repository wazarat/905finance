import "server-only";
import { getAddress, isAddressEqual, parseAbi, zeroAddress, type Address } from "viem";
import { z } from "zod";
import { ERC8004_AGENT_REGISTRY, ERC8004_TESTNET3, GOAT_TESTNET3 } from "@/lib/goat";
import { assertTestnet3, goatClient } from "./chain";
import { fetchPublicJson } from "./safe-fetch";

/**
 * Reading ERC-8004 from GOAT Testnet3: who an agent is, where it is paid,
 * and what others have recorded about it.
 *
 * Everything returned here is what the chain, or the document the chain
 * points to, says. A registration identifies an agent. It is not evidence
 * that a business is legitimate, and nothing here presents it as such.
 * Reading is all this does: there is no key and no transaction.
 */

const identityAbi = parseAbi([
  "function ownerOf(uint256 agentId) view returns (address)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);

const reputationAbi = parseAbi([
  "function getClients(uint256 agentId) view returns (address[])",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);

const identityRegistry = ERC8004_TESTNET3.identityRegistry as Address;
const reputationRegistry = ERC8004_TESTNET3.reputationRegistry as Address;

/** Agent ids are the registry's token ids: non-negative whole numbers. */
export function parseAgentId(value: unknown): bigint | null {
  const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  if (!/^\d{1,30}$/.test(text)) return null;
  return BigInt(text);
}

const service = z.object({
  name: z.string().max(100),
  endpoint: z.string().max(1_000),
  version: z.string().max(50).optional(),
});

/** The registration document, read leniently: only fields this application shows are kept. */
const registrationFile = z.object({
  type: z.string().max(300).optional(),
  name: z.string().max(200).optional(),
  description: z.string().max(4_000).optional(),
  services: z.array(z.unknown()).max(50).optional(),
  x402Support: z.boolean().optional(),
  active: z.boolean().optional(),
  registrations: z.array(z.unknown()).max(50).optional(),
  supportedTrust: z.array(z.string().max(100)).max(20).optional(),
});

export type AgentRegistration = {
  name: string | null;
  description: string | null;
  services: Array<{ name: string; endpoint: string; version: string | null }>;
  x402Support: boolean;
  active: boolean | null;
  supportedTrust: string[];
  /** True when the document itself names this registry and this agent id. */
  namesThisAgent: boolean;
};

export type AgentIdentity = {
  agentRegistry: string;
  agentId: string;
  owner: Address;
  /** Where the agent is paid, per the registry. Falls back to the owner when none is set. */
  agentWallet: Address;
  /** True when the registry holds a wallet set for the agent, rather than the owner standing in. */
  agentWalletSet: boolean;
  agentUri: string;
  /** Null when the document could not be read, with the reason alongside. */
  registration: AgentRegistration | null;
  registrationProblem: string | null;
};

function toRegistration(json: unknown, agentId: bigint): AgentRegistration | null {
  const parsed = registrationFile.safeParse(json);
  if (!parsed.success) return null;
  const file = parsed.data;
  const services = (file.services ?? []).flatMap((entry) => {
    const one = service.safeParse(entry);
    return one.success
      ? [{ name: one.data.name, endpoint: one.data.endpoint, version: one.data.version ?? null }]
      : [];
  });
  const namesThisAgent = (file.registrations ?? []).some((entry) => {
    const one = z
      .object({ agentRegistry: z.string(), agentId: z.union([z.number(), z.string()]) })
      .safeParse(entry);
    return (
      one.success &&
      one.data.agentRegistry.toLowerCase() === ERC8004_AGENT_REGISTRY.toLowerCase() &&
      parseAgentId(one.data.agentId) === agentId
    );
  });
  return {
    name: file.name ?? null,
    description: file.description ?? null,
    services,
    x402Support: file.x402Support === true,
    active: file.active ?? null,
    supportedTrust: file.supportedTrust ?? [],
    namesThisAgent,
  };
}

/** Read one agent's identity. Null when no such agent is registered. */
export async function readAgentIdentity(agentId: bigint): Promise<AgentIdentity | null> {
  await assertTestnet3();
  const chain = goatClient();
  let owner: Address;
  try {
    owner = await chain.readContract({
      address: identityRegistry,
      abi: identityAbi,
      functionName: "ownerOf",
      args: [agentId],
    });
  } catch (error) {
    // The registry reverts for an id that was never registered. That must not
    // be confused with the chain being unreachable: check it still answers.
    await chain.getBlockNumber().catch(() => {
      throw error;
    });
    return null;
  }
  const [agentUri, wallet] = await Promise.all([
    chain
      .readContract({ address: identityRegistry, abi: identityAbi, functionName: "tokenURI", args: [agentId] })
      .catch(() => ""),
    chain
      .readContract({ address: identityRegistry, abi: identityAbi, functionName: "getAgentWallet", args: [agentId] })
      .catch(() => zeroAddress),
  ]);

  let registration: AgentRegistration | null = null;
  let registrationProblem: string | null = null;
  if (!agentUri) {
    registrationProblem = "The agent has no registration document.";
  } else {
    const fetched = await fetchPublicJson(agentUri);
    if (!fetched.ok) registrationProblem = fetched.reason;
    else {
      registration = toRegistration(fetched.json, agentId);
      if (!registration) registrationProblem = "The registration document is not in the expected form.";
    }
  }

  const agentWalletSet = !isAddressEqual(wallet, zeroAddress);
  return {
    agentRegistry: ERC8004_AGENT_REGISTRY,
    agentId: agentId.toString(),
    owner: getAddress(owner),
    agentWallet: getAddress(agentWalletSet ? wallet : owner),
    agentWalletSet,
    agentUri: agentUri.slice(0, 2_000),
    registration,
    registrationProblem,
  };
}

export type AgentReputation = {
  /** How many addresses have left feedback. */
  clients: number;
  /** How many feedback entries the summary covers. */
  count: number;
  /** The registry's own summary value, as a decimal string, or null when there is no feedback. */
  value: string | null;
};

/** The registry's summary of an agent's feedback. Nothing is computed or estimated here. */
export async function readAgentReputation(agentId: bigint): Promise<AgentReputation> {
  await assertTestnet3();
  const chain = goatClient();
  const clients = await chain
    .readContract({ address: reputationRegistry, abi: reputationAbi, functionName: "getClients", args: [agentId] })
    .catch(() => [] as readonly Address[]);
  if (clients.length === 0) return { clients: 0, count: 0, value: null };

  const [count, summaryValue, decimals] = await chain.readContract({
    address: reputationRegistry,
    abi: reputationAbi,
    functionName: "getSummary",
    args: [agentId, [...clients].slice(0, 200), "", ""],
  });
  if (count === 0n) return { clients: clients.length, count: 0, value: null };
  const negative = summaryValue < 0n;
  const digits = (negative ? -summaryValue : summaryValue).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? `.${digits.slice(-decimals)}` : "";
  return { clients: clients.length, count: Number(count), value: `${negative ? "-" : ""}${whole}${fraction}` };
}

export const ERC8004_NETWORK = GOAT_TESTNET3.name;
