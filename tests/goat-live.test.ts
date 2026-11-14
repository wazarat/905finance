import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  getAddress,
  type Address,
  type Hash,
  type PublicClient,
} from "viem";
import { GoatFlowError } from "goatflow-sdk-server";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { ERC8004_AGENT_REGISTRY, ERC8004_TESTNET3, GOAT_TESTNET3 } from "@/lib/goat";
import { completeOnboarding } from "@/server/accounts";
import type { AgentBrain } from "@/server/agent/brain";
import { runAgent } from "@/server/agent/runtime";
import type { Actor } from "@/server/authz";
import { getBudgetStatus } from "@/server/budget";
import {
  authorizeEngagement,
  authorizeFunding,
  cancelEngagement,
  createEngagement,
  getEngagementDetail,
  provisionEngagementWallet,
  saveMandateDraft,
} from "@/server/engagements";
import { setGoatClient } from "@/server/goat/chain";
import { setGoatFlow, type FlowOrder, type GoatFlow } from "@/server/goat/flow";
import { goatLiveConfig, goatLiveGaps, resetGoatLiveChecks } from "@/server/goat/live";
import { setSafeFetchHooks } from "@/server/goat/safe-fetch";
import { setGoatSigner, type GoatSigner } from "@/server/goat/signer";
import { linkSellerIdentityAsOperator } from "@/server/identity";
import { goatFlowTiming } from "@/server/payments/goat-flow";
import { reconcilePurchase } from "@/server/policy";
import { createProject } from "@/server/projects";
import { createOffering, saveSellerEndpoint, updateSellerListing } from "@/server/sellers";
import { depositSimulatedFunds } from "@/server/wallets";
import { currentSettlement } from "@/server/wallets/registry";
import {
  fixtureProject,
  markSample,
  platformActivate,
  createUser,
  registerWorker,
  useTestDatabase,
  validEndpoint,
  validListing,
} from "./support/db";

const TOKEN = getAddress("0x030B2C744Fa080D97c0033214dEF6384f763aB21");
const SELLER_OWNER = getAddress("0x1111111111111111111111111111111111111111");
const SELLER_WALLET = getAddress("0x2222222222222222222222222222222222222222");
const BUYER_WALLET = getAddress("0x4444444444444444444444444444444444444444");
const STRANGER = getAddress("0x5555555555555555555555555555555555555555");
const ONE = 10n ** 18n;

let db: Db;
let close: () => Promise<void>;

type Buyer = { owner: Actor; org: string; projectId: string };
type Seller = { slug: string; id: string; offering: string };
let acme: Buyer;
let globex: Buyer;
/** Registered on GOAT, with a confirmed identity and a receiving wallet. */
let relay: Seller;
/** A sample seller with no GOAT identity. */
let plain: Seller;

/** A stand-in for Testnet3: balances, receipts, the registries, and blocks that advance. */
class FakeChain {
  head = 1_000n;
  token = new Map<string, bigint>();
  gas = new Map<string, bigint>();
  receipts = new Map<string, unknown>();
  agentWallet: Address = SELLER_WALLET;
  down = false;

  client(): PublicClient {
    return {
      getChainId: async () => GOAT_TESTNET3.id,
      getBlockNumber: async () => {
        if (this.down) throw new Error("rpc down");
        return this.head;
      },
      getGasPrice: async () => 130_007n,
      getBalance: async ({ address }: { address: Address }) => this.gas.get(address) ?? 0n,
      getTransactionReceipt: async ({ hash }: { hash: Hash }) => {
        if (this.down) throw new Error("rpc down");
        const receipt = this.receipts.get(hash);
        if (!receipt) throw new Error("not found");
        return receipt;
      },
      readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
        if (this.down) throw new Error("rpc down");
        if (address === TOKEN) {
          if (functionName === "symbol") return "tUSDT";
          if (functionName === "decimals") return 18;
          if (functionName === "balanceOf") return this.token.get(args![0] as string) ?? 0n;
        }
        if (address === ERC8004_TESTNET3.identityRegistry) {
          if (args![0] !== 7n) throw new Error("ERC721NonexistentToken");
          if (functionName === "ownerOf") return SELLER_OWNER;
          if (functionName === "tokenURI") return "https://agent.example/7.json";
          if (functionName === "getAgentWallet") return this.agentWallet;
        }
        if (address === ERC8004_TESTNET3.reputationRegistry) return functionName === "getClients" ? [] : [0n, 0n, 0];
        throw new Error(`unexpected call ${functionName}`);
      },
    } as unknown as PublicClient;
  }

  /** Put a token transfer on the chain and move the balances. */
  transfer(input: { from: Address; to: Address; value: bigint; token?: Address; status?: string; block?: bigint }): Hash {
    const hash = `0x${createHash("sha256").update(randomUUID()).digest("hex")}` as Hash;
    const block = input.block ?? this.head - 5n;
    this.receipts.set(hash, {
      status: input.status ?? "success",
      blockNumber: block,
      logs: [
        {
          address: input.token ?? TOKEN,
          topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: input.from, to: input.to } }),
          data: encodeAbiParameters([{ type: "uint256" }], [input.value]),
          blockNumber: block,
          logIndex: 0,
          transactionHash: hash,
          transactionIndex: 0,
          blockHash: `0x${"00".repeat(32)}`,
          removed: false,
        },
      ],
    });
    if ((input.status ?? "success") === "success" && (input.token ?? TOKEN) === TOKEN) {
      this.token.set(input.from, (this.token.get(input.from) ?? 0n) - input.value);
      this.token.set(input.to, (this.token.get(input.to) ?? 0n) + input.value);
    }
    return hash;
  }
}

/** A stand-in for Privy: it creates wallets and signs the one kind of transaction it is asked for. */
class FakeSigner implements GoatSigner {
  wallets = new Map<string, { id: string; address: Address }>();
  sent: Array<{ walletId: string; from: Address; token: Address; to: Address; amountUnits: bigint }> = [];
  mode: "ok" | "throws" | "reverts" | "slow" = "ok";

  constructor(private readonly chain: FakeChain) {}

  async createWallet({ externalId }: { externalId: string }) {
    let wallet = this.wallets.get(externalId);
    if (!wallet) {
      wallet = {
        id: `privy-wallet-${this.wallets.size + 1}`,
        address: getAddress(`0x${createHash("sha256").update(externalId).digest("hex").slice(0, 40)}`),
      };
      this.wallets.set(externalId, wallet);
    }
    return wallet;
  }

  async sendTokenTransfer(input: { walletId: string; from: Address; token: Address; to: Address; amountUnits: bigint }) {
    if (this.mode === "throws") throw new Error("privy unavailable");
    this.sent.push(input);
    return this.chain.transfer({
      from: input.from,
      to: input.to,
      value: input.amountUnits,
      token: input.token,
      status: this.mode === "reverts" ? "reverted" : "success",
      // A slow transfer sits in the newest block, so it does not yet have blocks on top.
      block: this.mode === "slow" ? this.chain.head : undefined,
    });
  }
}

/** A stand-in for GOAT Flow's merchant API. */
class FakeFlow implements GoatFlow {
  orders = new Map<string, FlowOrder & { status: string; dappOrderId: string }>();
  cancelled: string[] = [];
  payTo: Address = SELLER_WALLET;
  override: Partial<FlowOrder> = {};
  failWith: Error | null = null;

  async createOrder(input: { dappOrderId: string; fromAddress: string; amountUnits: bigint }): Promise<FlowOrder> {
    if (this.failWith) throw this.failWith;
    if ([...this.orders.values()].some((o) => o.dappOrderId === input.dappOrderId)) {
      throw new GoatFlowError("order already exists", "DUPLICATE", 409);
    }
    const order = {
      orderId: `order-${this.orders.size + 1}`,
      flow: "ERC20_DIRECT",
      tokenContract: TOKEN as string,
      payToAddress: this.payTo as string,
      chainId: GOAT_TESTNET3.id,
      amountUnits: input.amountUnits,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      ...this.override,
    };
    this.orders.set(order.orderId, { ...order, status: "CHECKOUT_VERIFIED", dappOrderId: input.dappOrderId });
    return order;
  }

  async getOrder(orderId: string) {
    const order = this.orders.get(orderId);
    if (!order) throw new GoatFlowError("not found", "NOT_FOUND", 404);
    return { status: order.status === "CHECKOUT_VERIFIED" ? "INVOICED" : order.status, transactionHash: null };
  }

  async cancelOrder(orderId: string) {
    this.cancelled.push(orderId);
    const order = this.orders.get(orderId);
    if (order) order.status = "CANCELLED";
  }
}

let chain: FakeChain;
let signer: FakeSigner;
let flow: FakeFlow;
let documentBody: string;

const LIVE_ENV = {
  GOAT_SETTLEMENT: "testnet3",
  GOAT_USD_TOKEN_ADDRESS: TOKEN,
  GOAT_USD_TOKEN_SYMBOL: "TUSDT",
  GOAT_USD_TOKEN_DECIMALS: "18",
  GOATX402_API_URL: "https://flow-api.testnet3.goat.network",
  GOATX402_API_KEY: "test-key",
  GOATX402_API_SECRET: "test-secret",
  GOATX402_MERCHANT_ID: "905_TEST",
  NEXT_PUBLIC_PRIVY_APP_ID: "privy-app",
  PRIVY_APP_SECRET: "privy-secret",
} as const;

function setLive(on: boolean, overrides: Record<string, string | undefined> = {}) {
  for (const [key, value] of Object.entries(LIVE_ENV)) {
    if (on) process.env[key] = value;
    else delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const registrationFor = (slug: string | null) =>
  JSON.stringify({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "Relay QA agent",
    services: slug ? [{ name: "905finance", endpoint: `https://905finance.vercel.app/agents/${slug}` }] : [],
    registrations: [{ agentRegistry: ERC8004_AGENT_REGISTRY, agentId: 7 }],
  });

async function createSeller(label: string): Promise<Seller> {
  const owner = await createUser(db, `${label}-owner`);
  const ws = await completeOnboarding(owner, {
    displayName: `${label} owner`,
    organizationName: `${label} agents`,
    accountType: "business",
    roles: "seller",
  });
  await updateSellerListing(owner, ws.organization.id, { ...validListing, displayName: `${label} agents`, capabilities: ["unit_testing"] });
  await saveSellerEndpoint(owner, ws.organization.id, validEndpoint);
  const offering = await createOffering(owner, ws.organization.id, {
    name: "Unit test run",
    description: "",
    capability: "unit_testing",
    billingUnit: "per_run",
    priceMinor: 1000,
  });
  await platformActivate(db, ws.sellerProfile!.slug);
  await markSample(db, ws.sellerProfile!.slug);
  return { slug: ws.sellerProfile!.slug, id: ws.sellerProfile!.id, offering: offering.id };
}

async function createBuyer(label: string): Promise<Buyer> {
  const owner = await createUser(db, `${label}-owner`);
  const ws = await completeOnboarding(owner, {
    displayName: `${label} owner`,
    organizationName: `${label} software`,
    accountType: "business",
    roles: "buyer",
  });
  const project = await createProject(owner, ws.organization.id, fixtureProject);
  return { owner, org: ws.organization.id, projectId: project.id };
}

async function drafted(buyer: Buyer, seller: Seller) {
  const engagement = await createEngagement(buyer.owner, buyer.org, { sellerSlug: seller.slug, projectId: buyer.projectId });
  await saveMandateDraft(buyer.owner, engagement.id, {
    totalBudget: "25",
    perTransactionLimit: "10",
    offeringIds: [seller.offering],
    scope: "Run the unit suite and report what fails.",
    expiresInDays: 30,
  });
  return engagement.id;
}

/** An authorized engagement with a real, unfunded wallet. */
async function awaitingFunding(buyer: Buyer = acme) {
  const id = await drafted(buyer, relay);
  await authorizeEngagement(buyer.owner, id, { confirmed: true });
  await provisionEngagementWallet(buyer.owner, id);
  return { id, wallet: await walletOf(id) };
}

/** The buyer sends tokens from their own wallet, then authorizes the funding with the transaction hash. */
async function fund(buyer: Buyer, id: string, wallet: Address, amount: string, from: Address = BUYER_WALLET) {
  const hash = chain.transfer({ from, to: wallet, value: BigInt(amount) * ONE });
  return authorizeFunding(buyer.owner, id, { amount, idempotencyKey: randomUUID(), confirmed: true, transactionHash: hash });
}

/** A funded, active, real engagement whose wallet also holds gas. */
async function active(buyer: Buyer = acme, amount = "25") {
  const { id, wallet } = await awaitingFunding(buyer);
  await fund(buyer, id, wallet.providerRef as Address, amount);
  chain.gas.set(wallet.providerRef, 10n ** 15n);
  return { id, wallet: wallet.providerRef as Address };
}

async function walletOf(id: string) {
  const [row] = await db.select().from(schema.engagementWallets).where(eq(schema.engagementWallets.engagementId, id));
  return row;
}
async function engagementRow(id: string) {
  const [row] = await db.select().from(schema.engagements).where(eq(schema.engagements.id, id));
  return row;
}
const purchasesOf = (id: string) => db.select().from(schema.purchases).where(eq(schema.purchases.engagementId, id));
const flowOrders = () => db.select().from(schema.goatFlowOrders);
/** The GOAT Flow order record for the payment an engagement's wallet attempted. */
async function orderFrom(wallet: Address) {
  const [row] = await db.select().from(schema.goatFlowOrders).where(eq(schema.goatFlowOrders.fromAddress, wallet));
  return row;
}

const buyOnce: () => AgentBrain = () => {
  let bought = false;
  return {
    name: "test",
    async next() {
      if (bought) return { tool: "finish", input: { summary: "Done." } };
      bought = true;
      return { tool: "purchase_service", input: { offeringId: relay.offering, reason: "test" } };
    },
  };
};
const run = (buyer: Buyer, id: string) => runAgent(buyer.owner, id, { runKey: randomUUID() }, buyOnce());

beforeAll(async () => {
  process.env.SESSION_SECRET = "s".repeat(48);
  ({ db, close } = await useTestDatabase());
  relay = await createSeller("relay");
  plain = await createSeller("plain");
  acme = await createBuyer("acme");
  globex = await createBuyer("globex");
  goatFlowTiming.pollMs = 1;
  goatFlowTiming.chainWaitMs = 40;
  goatFlowTiming.flowWaitMs = 20;
});
afterAll(async () => close());

beforeEach(async () => {
  chain = new FakeChain();
  signer = new FakeSigner(chain);
  flow = new FakeFlow();
  documentBody = registrationFor(relay.slug);
  setGoatClient(chain.client());
  setGoatSigner(signer);
  setGoatFlow(flow);
  resetGoatLiveChecks();
  setSafeFetchHooks({
    resolve: async () => ["93.184.216.34"],
    fetch: (async () => new Response(documentBody)) as typeof fetch,
  });
  setLive(true);
  delete process.env.PRIVY_WALLET_POLICY_ID;
  await db.delete(schema.sellerIdentities);
  await linkSellerIdentityAsOperator(relay.slug, "7");
  chain.token.set(BUYER_WALLET, 1_000n * ONE);
  await registerWorker(db, [`${fixtureProject.fixtureKey}:unit_testing`]);
});
afterEach(() => {
  setGoatClient(undefined);
  setGoatSigner(undefined);
  setGoatFlow(undefined);
  setSafeFetchHooks(undefined);
  setLive(false);
});

describe("when real settlement is on", () => {
  it("needs every piece configured, and only ever means Testnet3", () => {
    expect(goatLiveGaps()).toEqual([]);
    expect(goatLiveConfig()).toMatchObject({
      token: { address: TOKEN, symbol: "TUSDT", decimals: 18 },
      flow: { apiUrl: "https://flow-api.testnet3.goat.network", merchantId: "905_TEST" },
      walletPolicyId: null,
    });
    expect(currentSettlement()).toBe("goat_testnet3");

    const missing: Array<Record<string, string | undefined>> = [
      { GOAT_SETTLEMENT: undefined },
      { GOAT_SETTLEMENT: "mainnet" },
      { GOAT_USD_TOKEN_ADDRESS: "0x1234" },
      { GOAT_USD_TOKEN_DECIMALS: "six" },
      { GOATX402_API_SECRET: undefined },
      { PRIVY_APP_SECRET: undefined },
      // GOAT Flow's production API, where the asset has value, is refused.
      { GOATX402_API_URL: "https://flow-api.goat.network" },
      { GOATX402_API_URL: "http://flow-api.testnet3.goat.network" },
      { GOATX402_API_URL: "https://flow-api.testnet3.goat.network.evil.example" },
    ];
    for (const change of missing) {
      setLive(true, change);
      expect(goatLiveConfig(), JSON.stringify(change)).toBeNull();
      expect(currentSettlement(), JSON.stringify(change)).toBe("simulated");
      expect(goatLiveGaps().length).toBeGreaterThan(0);
    }
  });

  it("an engagement is real only with a seller whose confirmed identity names a wallet", async () => {
    const real = await drafted(acme, relay);
    expect(await engagementRow(real)).toMatchObject({ settlement: "goat_testnet3", rail: "goat" });
    expect((await getEngagementDetail(acme.owner, real)).mandate?.asset).toEqual({ code: "TUSDT", decimals: 18 });

    // No identity at all.
    expect((await engagementRow(await drafted(acme, plain))).settlement).toBe("simulated");
    // An identity the registration does not confirm.
    documentBody = registrationFor(null);
    await linkSellerIdentityAsOperator(relay.slug, "7");
    expect((await engagementRow(await drafted(acme, relay))).settlement).toBe("simulated");
    // Confirmed, but the registry holds no wallet for the agent.
    documentBody = registrationFor(relay.slug);
    chain.agentWallet = "0x0000000000000000000000000000000000000000";
    await linkSellerIdentityAsOperator(relay.slug, "7");
    expect((await engagementRow(await drafted(acme, relay))).settlement).toBe("simulated");
    // Not configured.
    chain.agentWallet = SELLER_WALLET;
    await linkSellerIdentityAsOperator(relay.slug, "7");
    setLive(false);
    const simulated = await drafted(acme, relay);
    expect(await engagementRow(simulated)).toMatchObject({ settlement: "simulated" });
    expect((await getEngagementDetail(acme.owner, simulated)).mandate?.asset.code).toBe("SIM-USD");
  });

  it("authorizes payment to the wallet the registry names at that moment, and nowhere else", async () => {
    const id = await drafted(acme, relay);
    // Between drafting and authorizing, the seller moves its receiving wallet on-chain.
    chain.agentWallet = STRANGER;
    await authorizeEngagement(acme.owner, id, { confirmed: true });
    const [mandate] = await db.select().from(schema.spendingMandates).where(eq(schema.spendingMandates.engagementId, id));
    expect(mandate.authorizedRecipient).toBe(STRANGER);

    // An identity that stops being confirmed cannot be authorized against.
    const second = await drafted(acme, relay);
    documentBody = registrationFor(null);
    await expect(authorizeEngagement(acme.owner, second, { confirmed: true })).rejects.toMatchObject({ code: "conflict" });
    expect((await engagementRow(second)).state).toBe("SELLER_SELECTED");
    // Nor can one whose chain cannot be read.
    documentBody = registrationFor(relay.slug);
    chain.down = true;
    await expect(authorizeEngagement(acme.owner, second, { confirmed: true })).rejects.toMatchObject({ code: "conflict" });
  });

  it("cannot be turned from simulated to real, or back, once authorized", async () => {
    const { id } = await awaitingFunding();
    await expect(db.update(schema.engagements).set({ settlement: "simulated" }).where(eq(schema.engagements.id, id))).rejects.toThrow();
    setLive(false);
    const simulated = await drafted(acme, plain);
    await authorizeEngagement(acme.owner, simulated, { confirmed: true });
    await expect(db.update(schema.engagements).set({ settlement: "goat_testnet3" }).where(eq(schema.engagements.id, simulated))).rejects.toThrow();
    await expect(db.update(schema.engagements).set({ settlement: "mainnet" as never }).where(eq(schema.engagements.id, simulated))).rejects.toThrow();
  });
});

describe("a real engagement wallet", () => {
  it("is its own address, held by the wallet provider, with its handle kept private", async () => {
    const first = await awaitingFunding();
    const second = await awaitingFunding();
    expect(first.wallet).toMatchObject({ provider: "privy-goat-testnet3", isSimulated: false, asset: "TUSDT", assetDecimals: 18, balanceUnits: 0n });
    expect(first.wallet.providerRef).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(first.wallet.providerRef).not.toBe(second.wallet.providerRef);
    expect(first.wallet.custodyRef).toMatch(/^privy-wallet-/);
    expect([...signer.wallets.keys()]).toEqual(expect.arrayContaining([`eng-${first.id}`, `eng-${second.id}`]));
    // The page gets the address, never the provider's handle for the key.
    const detail = JSON.stringify(await getEngagementDetail(acme.owner, first.id), (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    expect(detail).toContain(first.wallet.providerRef);
    expect(detail).not.toContain(first.wallet.custodyRef as string);
    expect(detail).not.toContain("custodyRef");
  });

  it("is funded only by a transfer the chain confirms, exactly as authorized", async () => {
    const { id, wallet } = await awaitingFunding();
    const address = wallet.providerRef as Address;
    const attempt = (transactionHash: unknown, amount = "25") =>
      authorizeFunding(acme.owner, id, { amount, idempotencyKey: randomUUID(), confirmed: true, transactionHash }).catch((e) => e);

    // No hash, or something that is not one.
    for (const bad of [undefined, "", "0x1234", "paid, honest"]) {
      expect((await attempt(bad)).fieldErrors.transactionHash, String(bad)).toBeDefined();
    }
    // A transaction nobody sent.
    expect(await attempt(`0x${"cd".repeat(32)}`)).toMatchObject({ code: "conflict" });
    // Transfers that are not the one authorized.
    const wrong: Array<[string, Hash, string?]> = [
      ["to another wallet", chain.transfer({ from: BUYER_WALLET, to: STRANGER, value: 25n * ONE })],
      ["a smaller amount", chain.transfer({ from: BUYER_WALLET, to: address, value: 24n * ONE })],
      ["a larger amount than claimed", chain.transfer({ from: BUYER_WALLET, to: address, value: 250n * ONE })],
      ["another token", chain.transfer({ from: BUYER_WALLET, to: address, value: 25n * ONE, token: STRANGER })],
      ["a transfer that reverted", chain.transfer({ from: BUYER_WALLET, to: address, value: 25n * ONE, status: "reverted" })],
    ];
    for (const [label, hash] of wrong) {
      expect((await attempt(hash)).fieldErrors?.transactionHash, label).toBeDefined();
    }
    // One that is real but too fresh: nothing is credited yet, and it can be tried again.
    const fresh = chain.transfer({ from: BUYER_WALLET, to: address, value: 25n * ONE, block: chain.head });
    expect(await attempt(fresh)).toMatchObject({ code: "conflict" });
    expect(await db.select().from(schema.fundingAuthorizations).where(eq(schema.fundingAuthorizations.engagementId, id))).toEqual([]);
    expect((await walletOf(id)).balanceUnits).toBe(0n);
    expect((await engagementRow(id)).state).toBe("AWAITING_FUNDING");

    chain.head += 2n;
    const outcome = await authorizeFunding(acme.owner, id, { amount: "25", idempotencyKey: randomUUID(), confirmed: true, transactionHash: fresh });
    expect(outcome.funding).toMatchObject({ status: "executed", providerRef: fresh, isSimulated: false, amountUnits: 25n * ONE });
    expect(outcome.engagement.state).toBe("ACTIVE");
    expect((await walletOf(id)).balanceUnits).toBe(25n * ONE);
  });

  it("credits one transfer once, to one engagement", async () => {
    const first = await awaitingFunding();
    const second = await awaitingFunding();
    const hash = chain.transfer({ from: BUYER_WALLET, to: first.wallet.providerRef as Address, value: 10n * ONE });
    const submit = (id: string) =>
      authorizeFunding(acme.owner, id, { amount: "10", idempotencyKey: randomUUID(), confirmed: true, transactionHash: hash }).catch((e) => e);
    expect((await submit(first.id)).funding.status).toBe("executed");
    expect((await submit(first.id)).fieldErrors.transactionHash[0]).toContain("already been credited");
    expect((await submit(second.id)).fieldErrors.transactionHash).toBeDefined();
    expect((await walletOf(first.id)).balanceUnits).toBe(10n * ONE);
    expect((await walletOf(second.id)).balanceUnits).toBe(0n);
    // The database refuses a second record of the same transfer, whatever the application does.
    const [funding] = await db.select().from(schema.fundingAuthorizations).where(eq(schema.fundingAuthorizations.engagementId, first.id));
    await expect(
      db.insert(schema.fundingAuthorizations).values({ ...funding, id: randomUUID(), idempotencyKey: randomUUID() }),
    ).rejects.toThrow();
  });

  it("comes from the organization's one funding wallet, which the platform does not hold", async () => {
    const { id, wallet } = await awaitingFunding();
    await fund(acme, id, wallet.providerRef as Address, "10");
    const masters = await db.select().from(schema.masterWalletAccounts).where(eq(schema.masterWalletAccounts.organizationId, acme.org));
    const funding = masters.find((m) => !m.isSimulated)!;
    expect(funding).toMatchObject({ provider: "buyer-wallet", providerRef: BUYER_WALLET, rail: "goat", balanceUnits: 0n });

    // A top-up from somewhere else is not this organization's money.
    chain.token.set(STRANGER, 100n * ONE);
    const error = await fund(acme, id, wallet.providerRef as Address, "5", STRANGER).catch((e) => e);
    expect(error.fieldErrors.transactionHash[0]).toContain("not from your organization's funding wallet");
    expect((await walletOf(id)).balanceUnits).toBe(10n * ONE);
    // Nor can another organization claim this one's wallet as its own.
    const other = await awaitingFunding(globex);
    const taken = await fund(globex, other.id, other.wallet.providerRef as Address, "5").catch((e) => e);
    expect(taken.fieldErrors.transactionHash[0]).toContain("another organization");

    // A simulated master account, if there is one, is a separate record and is never touched.
    await depositSimulatedFunds(acme.owner, acme.org, { amount: "500" });
    await fund(acme, id, wallet.providerRef as Address, "5");
    const after = await db.select().from(schema.masterWalletAccounts).where(eq(schema.masterWalletAccounts.organizationId, acme.org));
    expect(after.find((m) => m.isSimulated)?.balanceUnits).toBe(50000n);
    expect((await walletOf(id)).balanceUnits).toBe(15n * ONE);
  });
});

describe("a real payment", () => {
  it("is one GOAT Flow order and one transfer to the seller's wallet, confirmed from the chain", async () => {
    const { id, wallet } = await active();
    const result = await run(acme, id);
    expect(result.run).toMatchObject({ status: "completed", purchasesCompleted: 1 });

    expect(flow.orders.size).toBe(1);
    expect(signer.sent).toEqual([
      { walletId: (await walletOf(id)).custodyRef, from: wallet, token: TOKEN, to: SELLER_WALLET, amountUnits: 10n * ONE },
    ]);
    expect(chain.token.get(SELLER_WALLET)).toBe(10n * ONE);

    const [purchase] = await purchasesOf(id);
    expect(purchase).toMatchObject({ status: "paid", isSimulated: false, asset: "TUSDT", amountUnits: 10n * ONE, recipient: SELLER_WALLET });
    const [payment] = await db.select().from(schema.paymentTransactions).where(eq(schema.paymentTransactions.purchaseId, purchase.id));
    expect(payment).toMatchObject({ isSimulated: false, provider: "goat-flow", recipient: SELLER_WALLET, amountUnits: 10n * ONE });
    // The payment's reference is the transaction itself, which anyone can look up.
    expect(chain.receipts.has(payment.providerRef)).toBe(true);
    const [order] = await flowOrders();
    expect(order).toMatchObject({ status: "confirmed", flowStatus: "INVOICED", transactionHash: payment.providerRef, payToAddress: SELLER_WALLET });

    expect(await getBudgetStatus(db, id)).toMatchObject({ spentUnits: 10n * ONE, walletBalanceUnits: 15n * ONE });
    // The seller accepted the order on the strength of that reference, and the test is queued.
    expect(await db.select().from(schema.testingJobs).where(eq(schema.testingJobs.engagementId, id))).toHaveLength(1);
  });

  it("sends nothing when GOAT Flow's terms are not the ones approved", async () => {
    const terms: Array<[string, () => void]> = [
      ["another recipient", () => (flow.payTo = STRANGER)],
      ["another amount", () => (flow.override = { amountUnits: 11n * ONE })],
      ["another token", () => (flow.override = { tokenContract: STRANGER })],
      ["another network", () => (flow.override = { chainId: 2345 })],
      ["a payment method that hands over signing", () => (flow.override = { flow: "ERC20_3009" })],
    ];
    for (const [label, change] of terms) {
      flow = new FakeFlow();
      setGoatFlow(flow);
      change();
      const { id } = await active();
      const result = await run(acme, id);
      expect(result.run.purchasesCompleted, label).toBe(0);
      expect(signer.sent, label).toEqual([]);
      expect(flow.cancelled, label).toHaveLength(1);
      expect((await purchasesOf(id))[0], label).toMatchObject({ status: "payment_failed" });
      expect(await getBudgetStatus(db, id), label).toMatchObject({ spentUnits: 0n, reservedUnits: 0n, walletBalanceUnits: 25n * ONE });
    }
  });

  it("sends nothing when the wallet cannot pay the network fee or does not hold the tokens", async () => {
    const noGas = await active();
    chain.gas.set(noGas.wallet, 0n);
    expect((await run(acme, noGas.id)).run.purchasesCompleted).toBe(0);
    expect((await orderFrom(noGas.wallet)).failureReason).toContain("network fee");

    const noTokens = await active();
    // The ledger says 25, but the chain says the wallet was emptied by something outside the platform.
    chain.token.set(noTokens.wallet, 0n);
    expect((await run(acme, noTokens.id)).run.purchasesCompleted).toBe(0);
    expect((await orderFrom(noTokens.wallet)).failureReason).toContain("does not hold enough");
    expect(signer.sent).toEqual([]);
    expect(flow.cancelled).toHaveLength(2);
  });

  it("does not let extra tokens in the wallet buy more than was funded and authorized", async () => {
    const { id, wallet } = await active(acme, "10");
    // Someone sends the wallet 1,000 tokens directly, outside any funding authorization.
    chain.token.set(wallet, 1_010n * ONE);
    await run(acme, id);
    const second = await run(acme, id);
    expect(second.run.purchasesCompleted).toBe(0);
    expect(await purchasesOf(id)).toHaveLength(2);
    expect((await purchasesOf(id)).filter((p) => p.status === "paid")).toHaveLength(1);
    expect(signer.sent).toHaveLength(1);
  });

  it("treats a refusal as a failure and an unanswered request as unknown, and repeats neither", async () => {
    const refused = await active();
    flow.failWith = new GoatFlowError("merchant fee balance depleted", "FEE_BALANCE", 402);
    await run(acme, refused.id);
    expect((await purchasesOf(refused.id))[0]).toMatchObject({ status: "payment_failed" });
    expect(await getBudgetStatus(db, refused.id)).toMatchObject({ reservedUnits: 0n });

    const unknown = await active();
    flow.failWith = new Error("socket hang up");
    const result = await run(acme, unknown.id);
    expect(result.run.status).toBe("paused");
    const [purchase] = await purchasesOf(unknown.id);
    expect(purchase.status).toBe("needs_reconciliation");
    // The money stays set aside, and nothing is sent or asked for again.
    expect(await getBudgetStatus(db, unknown.id)).toMatchObject({ reservedUnits: 10n * ONE });
    flow.failWith = null;
    await reconcilePurchase(acme.owner, purchase.id);
    expect((await purchasesOf(unknown.id))[0].status).toBe("needs_reconciliation");
    expect(flow.orders.size).toBe(0);
    expect(signer.sent).toEqual([]);
    expect(await orderFrom(unknown.wallet)).toMatchObject({ status: "creation_unknown" });
  });

  it("does not send again when it cannot tell whether the transfer went out", async () => {
    const { id, wallet } = await active();
    signer.mode = "throws";
    await run(acme, id);
    const [purchase] = await purchasesOf(id);
    expect(purchase.status).toBe("needs_reconciliation");
    expect(await orderFrom(wallet)).toMatchObject({ status: "sending", transactionHash: null });
    signer.mode = "ok";
    await reconcilePurchase(acme.owner, purchase.id);
    expect(signer.sent).toEqual([]);
    expect((await purchasesOf(id))[0].status).toBe("needs_reconciliation");
  });

  it("records a transfer that reverted as nothing paid", async () => {
    const { id, wallet } = await active();
    signer.mode = "reverts";
    await run(acme, id);
    expect((await purchasesOf(id))[0]).toMatchObject({ status: "payment_failed" });
    expect(chain.token.get(wallet)).toBe(25n * ONE);
    expect(await getBudgetStatus(db, id)).toMatchObject({ spentUnits: 0n, reservedUnits: 0n, walletBalanceUnits: 25n * ONE });
    expect(await orderFrom(wallet)).toMatchObject({ status: "failed" });
  });

  it("waits out a slow confirmation by reconciling, never by paying twice", async () => {
    const { id, wallet } = await active();
    signer.mode = "slow";
    await run(acme, id);
    const [purchase] = await purchasesOf(id);
    expect(purchase.status).toBe("needs_reconciliation");
    const order = await orderFrom(wallet);
    expect(order).toMatchObject({ status: "sent" });
    expect(order.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);

    // Still too fresh: nothing changes.
    await reconcilePurchase(acme.owner, purchase.id);
    expect((await purchasesOf(id))[0].status).toBe("needs_reconciliation");
    // Blocks arrive. The same transaction is confirmed; no second one is sent.
    chain.head += 3n;
    await reconcilePurchase(acme.owner, purchase.id);
    expect((await purchasesOf(id))[0].status).toBe("paid");
    expect(signer.sent).toHaveLength(1);
    expect(flow.orders.size).toBe(1);
    expect(await getBudgetStatus(db, id)).toMatchObject({ spentUnits: 10n * ONE, reservedUnits: 0n });
  });

  it("keeps simulated and real engagements on their own providers, with no fallback either way", async () => {
    // A simulated engagement, started while real settlement is on, stays with the demo provider.
    const simulatedId = await drafted(acme, plain);
    await authorizeEngagement(acme.owner, simulatedId, { confirmed: true });
    await provisionEngagementWallet(acme.owner, simulatedId);
    await depositSimulatedFunds(acme.owner, acme.org, { amount: "100" });
    await authorizeFunding(acme.owner, simulatedId, { amount: "25", idempotencyKey: randomUUID(), confirmed: true });
    expect(await walletOf(simulatedId)).toMatchObject({ isSimulated: true, provider: "simulated" });
    expect(signer.wallets.has(`eng-${simulatedId}`)).toBe(false);
    expect(flow.orders.size).toBe(0);

    // A real engagement whose configuration goes away cannot pay, and does not fall back to the demo.
    const real = await active();
    setLive(false);
    const error = await run(acme, real.id).catch((e) => e);
    expect(error).toMatchObject({ code: "conflict" });
    expect(error.message).toContain("not configured");
    expect((await purchasesOf(real.id)).filter((p) => p.status === "paid" || p.status === "delivered")).toEqual([]);
    expect(await getBudgetStatus(db, real.id)).toMatchObject({ spentUnits: 0n });
    // It can still be ended.
    expect((await cancelEngagement(acme.owner, real.id)).state).toBe("CANCELLED");
  });
});
