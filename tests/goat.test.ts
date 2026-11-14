import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  getAddress,
  zeroAddress,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import {
  ERC8004_AGENT_REGISTRY,
  ERC8004_TESTNET3,
  GOAT_TESTNET3,
  agentExplorerLink,
  explorerLink,
  isEvmAddress,
  isTxHash,
  shortAddress,
} from "@/lib/goat";
import { completeOnboarding } from "@/server/accounts";
import type { Actor } from "@/server/authz";
import { assertTestnet3, gasBalance, readToken, setGoatClient, tokenBalance, verifyTokenTransfer } from "@/server/goat/chain";
import { parseAgentId, readAgentIdentity, readAgentReputation } from "@/server/goat/erc8004";
import { fetchPublicJson, setSafeFetchHooks } from "@/server/goat/safe-fetch";
import {
  getOwnSellerIdentity,
  linkSellerIdentity,
  linkSellerIdentityAsOperator,
  refreshOwnSellerIdentity,
  unlinkSellerIdentity,
  verifiedReceivingWallet,
} from "@/server/identity";
import { getPublicSellerBySlug } from "@/server/marketplace";
import { saveSellerEndpoint, updateSellerListing } from "@/server/sellers";
import {
  addMember,
  createUser,
  platformActivate,
  useTestDatabase,
  validEndpoint,
  validListing,
} from "./support/db";

const OWNER = getAddress("0x1111111111111111111111111111111111111111");
const WALLET = getAddress("0x2222222222222222222222222222222222222222");
const TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const PAYER = getAddress("0x4444444444444444444444444444444444444444");
const OTHER = getAddress("0x5555555555555555555555555555555555555555");
const TX = `0x${"ab".repeat(32)}` as Hash;

type Agent = { owner: Address; wallet: Address; uri: string; clients: Address[]; summary: [bigint, bigint, number] };

/**
 * A stand-in for the Testnet3 RPC, holding a few registered agents, a token
 * and some transaction receipts. It answers the same calls the real client
 * is asked, and reverts where the real registry reverts.
 */
class FakeChain {
  chainId: number = GOAT_TESTNET3.id;
  head = 1_000n;
  agents = new Map<bigint, Agent>();
  balances = new Map<string, bigint>();
  receipts = new Map<string, unknown>();
  down = false;

  client(): PublicClient {
    return {
      getChainId: async () => {
        if (this.down) throw new Error("rpc down");
        return this.chainId;
      },
      getBlockNumber: async () => {
        if (this.down) throw new Error("rpc down");
        return this.head;
      },
      getBalance: async ({ address }: { address: Address }) => {
        return this.balances.get(`native:${address}`) ?? 0n;
      },
      getTransactionReceipt: async ({ hash }: { hash: Hash }) => {
        const receipt = this.receipts.get(hash);
        if (!receipt) throw new Error("not found");
        return receipt;
      },
      readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
        if (this.down) throw new Error("rpc down");
        if (address === TOKEN) {
          if (functionName === "symbol") return "USDC";
          if (functionName === "decimals") return 6;
          if (functionName === "balanceOf") return this.balances.get(`token:${args![0]}`) ?? 0n;
        }
        const agent = this.agents.get(args![0] as bigint);
        if (address === ERC8004_TESTNET3.identityRegistry) {
          if (!agent) throw new Error("ERC721NonexistentToken");
          if (functionName === "ownerOf") return agent.owner;
          if (functionName === "tokenURI") return agent.uri;
          if (functionName === "getAgentWallet") return agent.wallet;
        }
        if (address === ERC8004_TESTNET3.reputationRegistry) {
          if (functionName === "getClients") return agent?.clients ?? [];
          if (functionName === "getSummary") return agent?.summary ?? [0n, 0n, 0];
        }
        throw new Error(`unexpected call ${functionName}`);
      },
    } as unknown as PublicClient;
  }

  /** A receipt holding one ERC-20 Transfer log. */
  transfer(input: { hash?: Hash; token?: Address; from?: Address; to?: Address; value?: bigint; status?: string; block?: bigint }) {
    const topics = encodeEventTopics({
      abi: erc20Abi,
      eventName: "Transfer",
      args: { from: input.from ?? PAYER, to: input.to ?? WALLET },
    });
    this.receipts.set(input.hash ?? TX, {
      status: input.status ?? "success",
      blockNumber: input.block ?? 990n,
      logs: [
        {
          address: input.token ?? TOKEN,
          topics,
          data: encodeAbiParameters([{ type: "uint256" }], [input.value ?? 2_500_000n]),
          blockNumber: input.block ?? 990n,
          logIndex: 0,
          transactionHash: input.hash ?? TX,
          transactionIndex: 0,
          blockHash: `0x${"00".repeat(32)}`,
          removed: false,
        },
      ],
    });
  }
}

let chain: FakeChain;
/** Registration documents by address, served by the stand-in network. */
let documents: Map<string, { status?: number; body?: string; location?: string; length?: number }>;
let fetched: string[];

function registration(slug: string | null, agentId: number, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Relay QA agent",
    description: "Runs test suites.",
    services: [
      { name: "MCP", endpoint: "https://agent.example/mcp", version: "2025-06-18" },
      ...(slug ? [{ name: "905finance", endpoint: `https://905finance.vercel.app/agents/${slug}` }] : []),
    ],
    x402Support: true,
    active: true,
    registrations: [{ agentRegistry: ERC8004_AGENT_REGISTRY, agentId }],
    ...overrides,
  });
}

beforeEach(() => {
  chain = new FakeChain();
  documents = new Map();
  fetched = [];
  setGoatClient(chain.client());
  setSafeFetchHooks({
    resolve: async (hostname) => (hostname === "internal.example" ? ["10.0.0.7"] : ["93.184.216.34"]),
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      const document = documents.get(url);
      if (!document) return new Response("not found", { status: 404 });
      if (document.location) return new Response(null, { status: 302, headers: { location: document.location } });
      return new Response(document.body ?? "", {
        status: document.status ?? 200,
        headers: document.length ? { "content-length": String(document.length) } : {},
      });
    }) as typeof fetch,
  });
});
afterEach(() => {
  setGoatClient(undefined);
  setSafeFetchHooks(undefined);
});

describe("GOAT Testnet3 only", () => {
  it("refuses an endpoint that is any other network", async () => {
    expect(GOAT_TESTNET3.id).toBe(48816);
    expect(ERC8004_AGENT_REGISTRY).toBe(`eip155:48816:${ERC8004_TESTNET3.identityRegistry}`);
    // A misconfigured endpoint that turns out to be GOAT mainnet.
    chain.chainId = 2345;
    setGoatClient(undefined);
    setGoatClient(chain.client(), { checked: false });
    await expect(assertTestnet3()).rejects.toThrow("not Testnet3");
    await expect(readToken(TOKEN)).rejects.toThrow("not Testnet3");
    await expect(tokenBalance(TOKEN, PAYER)).rejects.toThrow("not Testnet3");
    await expect(readAgentIdentity(7n)).rejects.toThrow("not Testnet3");
    chain.chainId = 48816;
    await expect(assertTestnet3()).resolves.toBeUndefined();
  });

  it("links addresses and transactions to the Testnet3 explorer, and nothing else", () => {
    expect(explorerLink(WALLET)).toBe(`https://explorer.testnet3.goat.network/address/${WALLET}`);
    expect(explorerLink(TX)).toBe(`https://explorer.testnet3.goat.network/tx/${TX}`);
    // Simulated references are not on any chain and get no link.
    for (const value of ["sim-wallet:goat:abc", "demo-payment:goat:1", "", null, undefined, "0x1234", `${WALLET}00`]) {
      expect(explorerLink(value), String(value)).toBeNull();
    }
    expect(agentExplorerLink("7")).toContain(`/token/${ERC8004_TESTNET3.identityRegistry}/instance/7`);
    expect(isEvmAddress(WALLET) && isTxHash(TX)).toBe(true);
    expect(isEvmAddress(TX) || isTxHash(WALLET)).toBe(false);
    expect(shortAddress(WALLET)).toBe("0x2222…2222");
  });

  it("reads a token and balances from the chain", async () => {
    chain.balances.set(`token:${PAYER}`, 12_500_000n);
    chain.balances.set(`native:${PAYER}`, 3n * 10n ** 15n);
    expect(await readToken(TOKEN)).toEqual({ address: TOKEN, symbol: "USDC", decimals: 6 });
    expect(await tokenBalance(TOKEN, PAYER)).toBe(12_500_000n);
    expect(await tokenBalance(TOKEN, OTHER)).toBe(0n);
    expect(await gasBalance(PAYER)).toBe(3n * 10n ** 15n);
    await expect(assertTestnet3()).resolves.toBeUndefined();
  });
});

describe("confirming a transfer from the chain", () => {
  const expected = { hash: TX, token: TOKEN, from: PAYER, to: WALLET, amountUnits: 2_500_000n };

  it("accepts exactly the expected transfer, once it has blocks on top", async () => {
    chain.transfer({});
    expect(await verifyTokenTransfer(expected)).toMatchObject({ ok: true, blockNumber: 990n });
  });

  it("is not satisfied by anything that differs", async () => {
    const differing: Array<[string, Parameters<FakeChain["transfer"]>[0]]> = [
      ["a smaller amount", { value: 2_499_999n }],
      ["a larger amount", { value: 2_500_001n }],
      ["another recipient", { to: OTHER }],
      ["another sender", { from: OTHER }],
      ["another token with the same figures", { token: OTHER }],
    ];
    for (const [label, change] of differing) {
      chain.transfer(change);
      expect(await verifyTokenTransfer(expected), label).toMatchObject({ ok: false, pending: false });
    }
  });

  it("does not count a transaction that failed, is unknown, or is too fresh", async () => {
    chain.transfer({ status: "reverted" });
    expect(await verifyTokenTransfer(expected)).toMatchObject({ ok: false, pending: false });

    chain.receipts.clear();
    expect(await verifyTokenTransfer(expected)).toMatchObject({ ok: false, pending: true });

    chain.transfer({ block: 1_000n });
    expect(await verifyTokenTransfer(expected)).toMatchObject({ ok: false, pending: true });
    chain.head = 1_001n;
    expect(await verifyTokenTransfer(expected)).toMatchObject({ ok: true });
  });
});

describe("reading a document from an address someone else chose", () => {
  it("reads public https, ipfs and inline documents", async () => {
    documents.set("https://agent.example/reg.json", { body: '{"name":"a"}' });
    documents.set("https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", { body: '{"name":"b"}' });
    expect(await fetchPublicJson("https://agent.example/reg.json")).toEqual({ ok: true, json: { name: "a" } });
    expect(await fetchPublicJson("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi")).toEqual({ ok: true, json: { name: "b" } });
    const inline = `data:application/json;base64,${Buffer.from('{"name":"c"}').toString("base64")}`;
    expect(await fetchPublicJson(inline)).toEqual({ ok: true, json: { name: "c" } });
    expect(await fetchPublicJson('data:application/json,{"name":"d"}')).toEqual({ ok: true, json: { name: "d" } });
  });

  it("never reaches into a private network, by name or by number", async () => {
    const forbidden = [
      "http://agent.example/reg.json",
      "https://internal.example/reg.json",
      "https://127.0.0.1/reg.json",
      "https://10.1.2.3/",
      "https://192.168.1.1/",
      "https://172.16.0.9/",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/",
      "https://[fd00::1]/",
      "https://[::ffff:10.0.0.1]/",
      "https://[::ffff:7f00:1]/",
      "https://[0:0:0:0:0:ffff:c0a8:101]/",
      "https://[64:ff9b::a00:1]/",
      "https://0.0.0.0/",
      "https://user:secret@agent.example/reg.json",
      "https://agent.example:8443/reg.json",
      "file:///etc/passwd",
      "ftp://agent.example/reg.json",
      "javascript:alert(1)",
      "not a url",
      "",
    ];
    for (const uri of forbidden) {
      expect(await fetchPublicJson(uri), uri).toMatchObject({ ok: false });
    }
    expect(fetched).toEqual([]);
  });

  it("follows no redirect, and stops at a size limit", async () => {
    documents.set("https://agent.example/moved", { location: "https://127.0.0.1/secret" });
    expect(await fetchPublicJson("https://agent.example/moved")).toMatchObject({ ok: false, reason: expect.stringContaining("redirects") });
    expect(fetched).toEqual(["https://agent.example/moved"]);

    documents.set("https://agent.example/huge-declared", { body: "{}", length: 5_000_000 });
    expect(await fetchPublicJson("https://agent.example/huge-declared")).toMatchObject({ ok: false });
    documents.set("https://agent.example/huge-actual", { body: `{"pad":"${"x".repeat(200_000)}"}` });
    expect(await fetchPublicJson("https://agent.example/huge-actual")).toMatchObject({ ok: false });
    documents.set("https://agent.example/not-json", { body: "<html>hello</html>" });
    expect(await fetchPublicJson("https://agent.example/not-json")).toMatchObject({ ok: false });
    documents.set("https://agent.example/gone", { status: 500 });
    expect(await fetchPublicJson("https://agent.example/gone")).toMatchObject({ ok: false });
  });
});

describe("reading ERC-8004", () => {
  it("reports what the registry and the registration say", async () => {
    chain.agents.set(7n, { owner: OWNER, wallet: WALLET, uri: "https://agent.example/7.json", clients: [PAYER, OTHER], summary: [3n, 425n, 2] });
    documents.set("https://agent.example/7.json", { body: registration("relay", 7) });

    expect(await readAgentIdentity(7n)).toEqual({
      agentRegistry: ERC8004_AGENT_REGISTRY,
      agentId: "7",
      owner: OWNER,
      agentWallet: WALLET,
      agentWalletSet: true,
      agentUri: "https://agent.example/7.json",
      registration: {
        name: "Relay QA agent",
        description: "Runs test suites.",
        services: [
          { name: "MCP", endpoint: "https://agent.example/mcp", version: "2025-06-18" },
          { name: "905finance", endpoint: "https://905finance.vercel.app/agents/relay", version: null },
        ],
        x402Support: true,
        active: true,
        supportedTrust: [],
        namesThisAgent: true,
      },
      registrationProblem: null,
    });
    // The summary is the registry's, with its own decimals. Nothing is computed here.
    expect(await readAgentReputation(7n)).toEqual({ clients: 2, count: 3, value: "4.25" });
  });

  it("says so when there is no agent, no wallet, no document or no feedback", async () => {
    expect(await readAgentIdentity(404n)).toBeNull();

    chain.agents.set(8n, { owner: OWNER, wallet: zeroAddress, uri: "", clients: [], summary: [0n, 0n, 0] });
    const bare = await readAgentIdentity(8n);
    expect(bare).toMatchObject({ agentWallet: OWNER, agentWalletSet: false, registration: null });
    expect(bare?.registrationProblem).toContain("no registration document");
    expect(await readAgentReputation(8n)).toEqual({ clients: 0, count: 0, value: null });

    chain.agents.set(9n, { owner: OWNER, wallet: WALLET, uri: "https://internal.example/9.json", clients: [PAYER], summary: [0n, 0n, 0] });
    expect((await readAgentIdentity(9n))?.registrationProblem).toContain("public host");
    expect(await readAgentReputation(9n)).toEqual({ clients: 1, count: 0, value: null });
  });

  it("formats the registry's value exactly, including negatives and small fractions", async () => {
    const cases: Array<[[bigint, bigint, number], string]> = [
      [[1n, 84n, 0], "84"],
      [[2n, 5n, 2], "0.05"],
      [[2n, -150n, 1], "-15.0"],
      [[9n, 100000n, 3], "100.000"],
    ];
    for (const [summary, shown] of cases) {
      chain.agents.set(1n, { owner: OWNER, wallet: WALLET, uri: "", clients: [PAYER], summary });
      expect((await readAgentReputation(1n)).value, shown).toBe(shown);
    }
  });

  it("does not take a registration at its word that it belongs to this agent", async () => {
    chain.agents.set(7n, { owner: OWNER, wallet: WALLET, uri: "https://agent.example/7.json", clients: [], summary: [0n, 0n, 0] });
    const wrong: Array<[string, Record<string, unknown>]> = [
      ["another agent id", { registrations: [{ agentRegistry: ERC8004_AGENT_REGISTRY, agentId: 8 }] }],
      ["another registry", { registrations: [{ agentRegistry: "eip155:2345:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432", agentId: 7 }] }],
      ["no registrations", { registrations: [] }],
      ["malformed registrations", { registrations: ["7", null, { agentId: 7 }] }],
    ];
    for (const [label, overrides] of wrong) {
      documents.set("https://agent.example/7.json", { body: registration("relay", 7, overrides) });
      expect((await readAgentIdentity(7n))?.registration?.namesThisAgent, label).toBe(false);
    }
    // The id may be written as a string; it is still the same agent.
    documents.set("https://agent.example/7.json", { body: registration("relay", 7, { registrations: [{ agentRegistry: ERC8004_AGENT_REGISTRY.toLowerCase(), agentId: "7" }] }) });
    expect((await readAgentIdentity(7n))?.registration?.namesThisAgent).toBe(true);
  });

  it("accepts only whole, non-negative agent ids", () => {
    expect(parseAgentId("42")).toBe(42n);
    expect(parseAgentId(" 0 ")).toBe(0n);
    expect(parseAgentId(7)).toBe(7n);
    for (const bad of ["", "-1", "1.5", "0x10", "seven", "1e3", "9".repeat(40), null, undefined, {}]) {
      expect(parseAgentId(bad), String(bad)).toBeNull();
    }
  });
});

describe("linking a listing to its agent", () => {
  let db: Db;
  let close: () => Promise<void>;
  let seller: Actor;
  let sellerOrg: string;
  let slug: string;
  let sellerProfileId: string;
  let admin: Actor;
  let member: Actor;
  let rival: Actor;
  let rivalOrg: string;
  let rivalSlug: string;

  async function createSeller(label: string) {
    const owner = await createUser(db, `${label}-owner`);
    const ws = await completeOnboarding(owner, {
      displayName: `${label} owner`,
      organizationName: `${label} agents`,
      accountType: "business",
      roles: "seller",
    });
    await updateSellerListing(owner, ws.organization.id, { ...validListing, displayName: `${label} agents` });
    await saveSellerEndpoint(owner, ws.organization.id, validEndpoint);
    await platformActivate(db, ws.sellerProfile!.slug);
    return { owner, org: ws.organization.id, slug: ws.sellerProfile!.slug, id: ws.sellerProfile!.id };
  }

  beforeAll(async () => {
    ({ db, close } = await useTestDatabase());
    const first = await createSeller("relay");
    ({ owner: seller, org: sellerOrg, slug, id: sellerProfileId } = first);
    const second = await createSeller("rival");
    ({ owner: rival, org: rivalOrg, slug: rivalSlug } = second);
    admin = await createUser(db, "relay-admin");
    member = await createUser(db, "relay-member");
    await addMember(db, sellerOrg, admin.userId, "admin");
    await addMember(db, sellerOrg, member.userId, "member");
  });
  afterAll(async () => close());
  beforeEach(async () => {
    await db.delete(schema.sellerIdentities);
    chain.agents.set(7n, { owner: OWNER, wallet: WALLET, uri: "https://agent.example/7.json", clients: [PAYER], summary: [1n, 90n, 0] });
    documents.set("https://agent.example/7.json", { body: registration(slug, 7) });
  });

  it("stores what the chain says, and confirms the link when the agent points back", async () => {
    const saved = await linkSellerIdentity(admin, sellerOrg, { agentId: "7" });
    expect(saved).toMatchObject({
      agentRegistry: ERC8004_AGENT_REGISTRY,
      agentId: "7",
      ownerAddress: OWNER,
      agentWallet: WALLET,
      agentWalletSet: true,
      confirmed: true,
      reputationCount: 1,
      reputationValue: "90",
    });
    expect(await verifiedReceivingWallet(sellerProfileId)).toBe(WALLET);

    const profile = await getPublicSellerBySlug(slug);
    expect(profile?.identity).toMatchObject({
      agentId: "7",
      confirmed: true,
      agentWallet: WALLET,
      ownerAddress: OWNER,
      registeredName: "Relay QA agent",
      reputation: { clients: 1, count: 1, value: "90" },
    });
    expect((await getPublicSellerBySlug(rivalSlug))?.identity).toBeNull();
  });

  it("treats a link the agent does not return as an unconfirmed claim, and never pays its wallet", async () => {
    const unreturned: Array<[string, string | null]> = [
      ["names another listing", registration(rivalSlug, 7)],
      ["names no listing", registration(null, 7)],
      ["names the listing on someone else's site", registration(null, 7, { services: [{ name: "905finance", endpoint: `https://evil.example/agents/${slug}` }] })],
      ["names the listing over plain http", registration(null, 7, { services: [{ name: "905finance", endpoint: `http://905finance.vercel.app/agents/${slug}` }] })],
      ["names the listing but is another agent's document", registration(slug, 8)],
      ["cannot be read", null],
    ];
    for (const [label, body] of unreturned) {
      if (body === null) documents.delete("https://agent.example/7.json");
      else documents.set("https://agent.example/7.json", { body });
      const saved = await linkSellerIdentity(seller, sellerOrg, { agentId: "7" });
      expect(saved.confirmed, label).toBe(false);
      expect(await verifiedReceivingWallet(sellerProfileId), label).toBeNull();
      expect((await getPublicSellerBySlug(slug))?.identity?.confirmed, label).toBe(false);
    }
  });

  it("cannot be used to take an agent another listing already holds", async () => {
    await linkSellerIdentity(seller, sellerOrg, { agentId: "7" });
    await expect(linkSellerIdentity(rival, rivalOrg, { agentId: "7" })).rejects.toMatchObject({ code: "conflict" });
    await expect(linkSellerIdentityAsOperator(rivalSlug, "7")).rejects.toMatchObject({ code: "conflict" });
    expect((await getOwnSellerIdentity(rival, rivalOrg))?.identity).toBeNull();
  });

  it("is for the listing's owners and admins, and only for their own listing", async () => {
    await expect(linkSellerIdentity(member, sellerOrg, { agentId: "7" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(linkSellerIdentity(rival, sellerOrg, { agentId: "7" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(linkSellerIdentity(null, sellerOrg, { agentId: "7" })).rejects.toMatchObject({ code: "unauthenticated" });
    await linkSellerIdentity(seller, sellerOrg, { agentId: "7" });
    await expect(unlinkSellerIdentity(member, sellerOrg)).rejects.toMatchObject({ code: "forbidden" });
    await expect(unlinkSellerIdentity(rival, sellerOrg)).rejects.toMatchObject({ code: "forbidden" });
    await expect(refreshOwnSellerIdentity(member, sellerOrg)).rejects.toMatchObject({ code: "forbidden" });
    expect((await getOwnSellerIdentity(member, sellerOrg))?.identity?.agentId).toBe("7");
    await expect(getOwnSellerIdentity(rival, sellerOrg)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses an id that is not one, or that nobody registered, and says which", async () => {
    for (const agentId of ["", "seven", "-1", "404"]) {
      const error = await linkSellerIdentity(seller, sellerOrg, { agentId }).catch((e) => e);
      expect(error.fieldErrors.agentId, agentId).toBeDefined();
    }
    chain.down = true;
    setGoatClient(chain.client());
    await expect(linkSellerIdentity(seller, sellerOrg, { agentId: "7" })).rejects.toMatchObject({ code: "conflict" });
    expect(await db.select().from(schema.sellerIdentities)).toEqual([]);
  });

  it("follows the chain when the agent's wallet or registration changes", async () => {
    await linkSellerIdentity(seller, sellerOrg, { agentId: "7" });
    // The owner moves the receiving wallet on-chain, and the document stops naming the listing.
    chain.agents.set(7n, { owner: OWNER, wallet: OTHER, uri: "https://agent.example/7.json", clients: [PAYER, OTHER], summary: [2n, 70n, 0] });
    const refreshed = await refreshOwnSellerIdentity(seller, sellerOrg);
    expect(refreshed).toMatchObject({ agentWallet: OTHER, confirmed: true, reputationCount: 2, reputationValue: "70" });
    expect(await verifiedReceivingWallet(sellerProfileId)).toBe(OTHER);

    documents.set("https://agent.example/7.json", { body: registration(null, 7) });
    expect((await refreshOwnSellerIdentity(seller, sellerOrg))?.confirmed).toBe(false);
    expect(await verifiedReceivingWallet(sellerProfileId)).toBeNull();
  });

  it("lets an operator link a sample seller, with no power to confirm what the chain does not", async () => {
    documents.set("https://agent.example/7.json", { body: registration(null, 7) });
    expect((await linkSellerIdentityAsOperator(slug, "7")).confirmed).toBe(false);
    documents.set("https://agent.example/7.json", { body: registration(slug, 7) });
    expect((await linkSellerIdentityAsOperator(slug, "7")).confirmed).toBe(true);
    await expect(linkSellerIdentityAsOperator("no-such-listing", "7")).rejects.toMatchObject({ code: "not_found" });
  });

  it("can be unlinked, and is recorded", async () => {
    await linkSellerIdentity(seller, sellerOrg, { agentId: "7" });
    await unlinkSellerIdentity(seller, sellerOrg);
    expect((await getOwnSellerIdentity(seller, sellerOrg))?.identity).toBeNull();
    expect(await verifiedReceivingWallet(sellerProfileId)).toBeNull();
    const actions = (await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.organizationId, sellerOrg))).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["seller_identity.linked", "seller_identity.unlinked"]));
  });
});
