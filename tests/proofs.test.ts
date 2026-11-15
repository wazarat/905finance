import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { concatHex, getAddress, keccak256, stringToBytes, type Address, type Hash, type Hex, type PublicClient } from "viem";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { completeOnboarding } from "@/server/accounts";
import type { AgentBrain } from "@/server/agent/brain";
import { runAgent } from "@/server/agent/runtime";
import { setSellerTransportResolver } from "@/server/agent/transport";
import type { Actor } from "@/server/authz";
import { cancelEngagement } from "@/server/engagements";
import { returnUnusedFunds } from "@/server/closure";
import { setGoatClient } from "@/server/goat/chain";
import { setGoatSigner, type GoatSigner } from "@/server/goat/signer";
import { GOAT_TESTNET3 } from "@/lib/goat";
import {
  PROOF_PREFIX,
  batchRoot,
  fingerprint,
  getProof,
  getProofStatus,
  listProofs,
  proofData,
  runProofs,
  syncProofRecords,
} from "@/server/proofs";
import {
  authorizeEngagement,
  authorizeFunding,
  createEngagement,
  provisionEngagementWallet,
  saveMandateDraft,
} from "@/server/engagements";
import { createProject } from "@/server/projects";
import { decideCase, rateEngagement } from "@/server/reputation";
import { createOffering, saveSellerEndpoint, updateSellerListing } from "@/server/sellers";
import { depositSimulatedFunds } from "@/server/wallets";
import {
  addMember,
  createUser,
  fixtureProject,
  markSample,
  platformActivate,
  registerWorker,
  useTestDatabase,
  validEndpoint,
  validListing,
} from "./support/db";

let db: Db;
let close: () => Promise<void>;

type Seller = { owner: Actor; org: string; slug: string; id: string; offering: string };
type Buyer = { owner: Actor; org: string; projectId: string };
let relay: Seller;
let ledger: Seller;
let acme: Buyer;
let globex: Buyer;
let acmeAdmin: Actor;
let acmeMember: Actor;
let operator: Actor & { email: string };
let stranger: Actor & { email: string };

const PROBLEM = "The report says six tests ran, but the suite has twelve. Half of it was skipped.";
const VERDICT = { verdict: "upheld", score: 30, note: "The worker's record shows only the unit suite was run.", confirmed: true };
const PROOF_WALLET = getAddress("0x9999999999999999999999999999999999999999");

/** A stand-in for GOAT Testnet3: blocks, balances, and the transactions the signer broadcast. */
class FakeChain {
  head = 1_000n;
  gas = new Map<string, bigint>();
  transactions = new Map<string, { from: Address; to: Address; input: Hex }>();
  receipts = new Map<string, { status: string; blockNumber: bigint }>();
  down = false;

  client(): PublicClient {
    const reach = () => {
      if (this.down) throw new Error("rpc down");
    };
    return {
      getChainId: async () => GOAT_TESTNET3.id,
      getBlockNumber: async () => (reach(), this.head),
      getGasPrice: async () => (reach(), 130_007n),
      getBalance: async ({ address }: { address: Address }) => (reach(), this.gas.get(address) ?? 0n),
      getTransaction: async ({ hash }: { hash: Hash }) => {
        reach();
        const found = this.transactions.get(hash);
        if (!found) throw new Error("not found");
        return found;
      },
      getTransactionReceipt: async ({ hash }: { hash: Hash }) => {
        reach();
        const found = this.receipts.get(hash);
        if (!found) throw new Error("not found");
        return found;
      },
    } as unknown as PublicClient;
  }
}

/** A stand-in for the custody provider: one wallet, and notes written from it to itself. */
class FakeSigner implements GoatSigner {
  created: Array<{ externalId: string; unrestricted?: boolean }> = [];
  notes: Hex[] = [];
  mode: "ok" | "throws" | "slow" | "reverts" | "unmined" = "ok";
  constructor(private readonly chain: FakeChain) {}

  async createWallet(input: { externalId: string; unrestricted?: boolean }) {
    this.created.push(input);
    return { id: "privy-proof-wallet", address: PROOF_WALLET };
  }
  async sendTokenTransfer(): Promise<Hash> {
    throw new Error("a proof never moves tokens");
  }
  async sendFeedback(): Promise<Hash> {
    throw new Error("not used here");
  }
  async sendNote(input: { walletId: string; from: Address; data: Hex }): Promise<Hash> {
    if (this.mode === "throws") throw new Error("privy unavailable");
    this.notes.push(input.data);
    const hash = keccak256(stringToBytes(`${input.data}:${this.notes.length}`));
    if (this.mode === "unmined") return hash;
    this.chain.transactions.set(hash, { from: input.from, to: input.from, input: input.data });
    this.chain.receipts.set(hash, {
      status: this.mode === "reverts" ? "reverted" : "success",
      blockNumber: this.mode === "slow" ? this.chain.head : this.chain.head - 5n,
    });
    return hash;
  }
}

let chain: FakeChain;
let signer: FakeSigner;
const records = () => db.select().from(schema.proofRecords).orderBy(schema.proofRecords.sequence);
const batches = () => db.select().from(schema.proofBatches).orderBy(schema.proofBatches.createdAt);
function setProofs(on: boolean) {
  if (on) {
    process.env.GOAT_PROOFS = "testnet3";
    process.env.NEXT_PUBLIC_PRIVY_APP_ID = "test-app";
    process.env.PRIVY_APP_SECRET = "test-secret";
  } else {
    delete process.env.GOAT_PROOFS;
    delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;
    delete process.env.PRIVY_APP_SECRET;
  }
}

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
  return { owner, org: ws.organization.id, slug: ws.sellerProfile!.slug, id: ws.sellerProfile!.id, offering: offering.id };
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
  await depositSimulatedFunds(owner, ws.organization.id, { amount: "5000" });
  return { owner, org: ws.organization.id, projectId: project.id };
}

const buyOnce = (offeringId: string): AgentBrain => {
  let bought = false;
  return {
    name: "test",
    async next() {
      if (bought) return { tool: "finish", input: { summary: "Done." } };
      bought = true;
      return { tool: "purchase_service", input: { offeringId, reason: "test" } };
    },
  };
};

/** An active engagement, with one paid purchase unless told otherwise. */
async function engaged(buyer: Buyer, seller: Seller, options: { buy?: boolean } = {}): Promise<string> {
  const engagement = await createEngagement(buyer.owner, buyer.org, { sellerSlug: seller.slug, projectId: buyer.projectId });
  await saveMandateDraft(buyer.owner, engagement.id, {
    totalBudget: "50",
    perTransactionLimit: "10",
    offeringIds: [seller.offering],
    scope: "Run the unit suite and report what fails.",
    expiresInDays: 30,
  });
  await authorizeEngagement(buyer.owner, engagement.id, { confirmed: true });
  await provisionEngagementWallet(buyer.owner, engagement.id);
  await authorizeFunding(buyer.owner, engagement.id, { amount: "50", idempotencyKey: randomUUID(), confirmed: true });
  if (options.buy !== false) {
    await runAgent(buyer.owner, engagement.id, { runKey: randomUUID() }, buyOnce(seller.offering));
  }
  return engagement.id;
}

beforeAll(async () => {
  ({ db, close } = await useTestDatabase());
  relay = await createSeller("relay");
  ledger = await createSeller("ledger");
  acme = await createBuyer("acme");
  globex = await createBuyer("globex");
  acmeAdmin = await createUser(db, "acme-admin");
  acmeMember = await createUser(db, "acme-member");
  await addMember(db, acme.org, acmeAdmin.userId, "admin");
  await addMember(db, acme.org, acmeMember.userId, "member");
  operator = await createUser(db, "validator");
  stranger = await createUser(db, "stranger");
});
afterAll(async () => close());
beforeEach(async () => {
  chain = new FakeChain();
  signer = new FakeSigner(chain);
  setGoatClient(chain.client());
  setGoatSigner(signer);
  setProofs(true);
  chain.gas.set(PROOF_WALLET, 10n ** 15n);
  // Each test starts with nothing waiting: earlier tests' records are settled out of the way.
  await db.delete(schema.proofRecords);
  await db.delete(schema.proofBatches);
  await db.delete(schema.platformWallets);
  await syncProofRecords();
  await db.delete(schema.proofBatches);
  const [parked] = await db
    .insert(schema.proofBatches)
    .values({ status: "failed", walletAddress: PROOF_WALLET, failureReason: "parked by the test" })
    .returning();
  await db.update(schema.proofRecords).set({ batchId: parked.id });
  setSellerTransportResolver(undefined);
  await db.delete(schema.testingWorkers);
  await registerWorker(db, [`${fixtureProject.fixtureKey}:unit_testing`]);
  process.env.PLATFORM_OPERATOR_EMAILS = ` ${operator.email.toUpperCase()} , someone-else@example.test`;
});
afterEach(() => {
  delete process.env.PLATFORM_OPERATOR_EMAILS;
  setGoatClient(undefined);
  setGoatSigner(undefined);
  setProofs(false);
});


describe("fingerprints", () => {
  it("are taken of every settled record: payments, fundings, returns, ratings and verdicts", async () => {
    const id = await engaged(acme, relay);
    const { caseOpened } = await rateEngagement(acme.owner, id, { stars: 1, comment: PROBLEM });
    await decideCase(operator, caseOpened!.id, VERDICT);
    await cancelEngagement(acme.owner, id);
    await returnUnusedFunds(acme.owner, id, { idempotencyKey: randomUUID(), confirmed: true });

    setProofs(false);
    expect(await runProofs()).toMatchObject({ state: "off", added: 5, sent: 0 });
    const mine = (await records()).filter((record) => record.engagementId === id);
    expect(mine.map((record) => record.kind).sort()).toEqual(["funding", "payment", "rating", "return", "verdict"]);
    for (const record of mine) {
      expect(record.organizationId).toBe(acme.org);
      expect(record.recordHash).toBe(keccak256(stringToBytes(record.document)));
      // Stored names and private words stay out of what is fingerprinted.
      expect(record.document).not.toMatch(/SIM-USD|demo-payment|sim-wallet|sim-funding|skipped/);
    }
    const payment = JSON.parse(mine.find((record) => record.kind === "payment")!.document);
    expect(payment).toMatchObject({ type: "905finance.payment.v1", asset: "USD", amountUnits: "1000", settledIn: "test funds" });
    // Nothing was sent anywhere, and no wallet was made, while proofs are off.
    expect(signer.created).toEqual([]);
    expect(signer.notes).toEqual([]);
    // Asking again adds nothing: one fingerprint per record.
    expect((await runProofs()).added).toBe(0);
    await expect(db.insert(schema.proofRecords).values({ ...mine[0], id: randomUUID() })).rejects.toThrow();
  });
});

describe("writing fingerprints to GOAT", () => {
  it("sends one transaction carrying the batch's combined fingerprint, and confirms it from the chain", async () => {
    const id = await engaged(acme, relay);
    const run = await runProofs();
    expect(run).toMatchObject({ state: "sent", added: 2, sent: 2 });
    // The proof wallet is the platform's own, made once, and not confined like an engagement wallet.
    expect(signer.created).toEqual([{ externalId: "905finance-proofs-v1", unrestricted: true }]);

    const [batch] = (await batches()).filter((entry) => entry.status !== "failed");
    const members = (await records()).filter((record) => record.batchId === batch.id);
    expect(members).toHaveLength(2);
    const root = keccak256(concatHex(members.map((member) => member.recordHash as Hex)));
    expect(batch).toMatchObject({ status: "confirmed", root, recordCount: 2, walletAddress: PROOF_WALLET });
    expect(batchRoot(members.map((member) => member.recordHash))).toBe(root);
    expect(signer.notes).toEqual([concatHex([PROOF_PREFIX, root])]);
    expect(proofData(root)).toBe(signer.notes[0]);
    expect(chain.transactions.get(batch.txHash!)).toMatchObject({ from: PROOF_WALLET, to: PROOF_WALLET });

    // Nothing waits, so nothing more is sent; a new payment makes a new batch.
    expect(await runProofs()).toMatchObject({ state: "idle", added: 0 });
    expect(signer.notes).toHaveLength(1);
    await runAgent(acme.owner, id, { runKey: randomUUID() }, buyOnce(relay.offering));
    expect(await runProofs()).toMatchObject({ state: "sent", added: 1, sent: 1 });
    expect(signer.notes).toHaveLength(2);
    expect(signer.created).toHaveLength(1);
  });

  it("waits, sending nothing, until the proof wallet can pay the network fee", async () => {
    await engaged(acme, relay);
    chain.gas.set(PROOF_WALLET, 0n);
    const run = await runProofs();
    expect(run.state).toBe("unfunded");
    expect(run.detail).toContain(PROOF_WALLET);
    expect(signer.notes).toEqual([]);
    expect(await getProofStatus()).toMatchObject({ enabled: true, walletAddress: PROOF_WALLET, funded: false, waiting: expect.any(Number) });
    chain.gas.set(PROOF_WALLET, 10n ** 15n);
    expect((await runProofs()).state).toBe("sent");
    expect(await getProofStatus()).toMatchObject({ funded: true, lastConfirmed: { txHash: expect.stringMatching(/^0x/) } });
  });

  it("tries again after a failure, since writing a fingerprint twice harms nothing", async () => {
    await engaged(acme, relay);
    signer.mode = "throws";
    expect(await runProofs()).toMatchObject({ state: "failed", sent: 0 });
    expect((await records()).filter((record) => record.batchId === null)).toHaveLength(2);

    // Rejected by the chain: released again.
    signer.mode = "reverts";
    expect((await runProofs()).state).toBe("sent");
    expect((await records()).filter((record) => record.batchId === null)).toHaveLength(2);

    // Sent but never included: released once it has clearly been dropped.
    signer.mode = "unmined";
    expect((await runProofs()).state).toBe("sent");
    expect((await runProofs()).state).toBe("idle");
    await db.update(schema.proofBatches).set({ sentAt: new Date(Date.now() - 60 * 60_000) }).where(eq(schema.proofBatches.status, "sent"));
    signer.mode = "ok";
    expect(await runProofs()).toMatchObject({ state: "sent", sent: 2 });
    const live = (await batches()).filter((batch) => batch.status === "confirmed");
    expect(live).toHaveLength(1);
    expect((await records()).filter((record) => record.batchId === live[0].id)).toHaveLength(2);
  });

  it("does not count a fingerprint as written until the chain has settled it", async () => {
    const id = await engaged(acme, relay);
    signer.mode = "slow";
    expect((await runProofs()).state).toBe("sent");
    const [payment] = (await records()).filter((record) => record.engagementId === id && record.kind === "payment");
    expect(await getProof(acme.owner, payment.id)).toMatchObject({ state: "sent", verified: false });
    expect((await listProofs(acme.owner, acme.org, "payment", [payment.entityId])).get(payment.entityId)).toMatchObject({ state: "sent" });
    chain.head += 3n;
    expect((await runProofs()).state).toBe("idle");
    expect(await getProof(acme.owner, payment.id)).toMatchObject({ state: "confirmed", verified: true });
  });

  it("puts each record in one batch only, however many requests ask at once", async () => {
    await engaged(acme, relay);
    await engaged(globex, ledger);
    const runs = await Promise.all(Array.from({ length: 6 }, () => runProofs()));
    expect(runs.filter((run) => run.state === "sent").length).toBeGreaterThanOrEqual(1);
    await runProofs();
    const live = (await batches()).filter((batch) => batch.status === "confirmed");
    const anchored = (await records()).filter((record) => live.some((batch) => batch.id === record.batchId));
    expect(anchored).toHaveLength(4);
    expect(live.reduce((sum, batch) => sum + batch.recordCount, 0)).toBe(4);
    expect((await batches()).filter((batch) => batch.status === "sending")).toEqual([]);
    await expect(db.insert(schema.proofBatches).values([{ walletAddress: PROOF_WALLET }, { walletAddress: PROOF_WALLET }])).rejects.toThrow();
  });

  it("never throws at whoever called it when GOAT cannot be reached", async () => {
    await engaged(acme, relay);
    chain.down = true;
    expect(await runProofs()).toMatchObject({ state: "failed", sent: 0 });
    chain.down = false;
    expect((await runProofs()).state).toBe("sent");
  });
});

describe("checking a proof", () => {
  it("re-does every step against the chain, and says so when any of them fails", async () => {
    const id = await engaged(acme, relay);
    await runProofs();
    const [payment] = (await records()).filter((record) => record.engagementId === id && record.kind === "payment");
    const proof = await getProof(acme.owner, payment.id);
    expect(proof).toMatchObject({ state: "confirmed", verified: true });
    expect(proof.checks.map((check) => check.passed)).toEqual([true, true, true, true]);
    expect(proof.batch).toMatchObject({ walletAddress: PROOF_WALLET, position: proof.batch!.hashes.indexOf(payment.recordHash) });
    expect(proof.batch!.data).toBe(proofData(proof.batch!.root));
    expect(fingerprint(proof.record.document)).toBe(proof.record.recordHash);

    // The record is altered after the fact: its document no longer matches its fingerprint.
    await db.update(schema.proofRecords).set({ document: payment.document.replace('"1000"', '"1"') }).where(eq(schema.proofRecords.id, payment.id));
    const altered = await getProof(acme.owner, payment.id);
    expect(altered.verified).toBe(false);
    expect(altered.checks[0].passed).toBe(false);
    await db.update(schema.proofRecords).set({ document: payment.document }).where(eq(schema.proofRecords.id, payment.id));

    // The fingerprint is swapped for another: it is not in what the chain holds.
    await db.update(schema.proofRecords).set({ recordHash: fingerprint("something else"), document: "something else" }).where(eq(schema.proofRecords.id, payment.id));
    const swapped = await getProof(acme.owner, payment.id);
    expect(swapped.checks.map((check) => check.passed)).toEqual([true, true, false, true]);
    expect(swapped.verified).toBe(false);
    await db.update(schema.proofRecords).set({ recordHash: payment.recordHash, document: payment.document }).where(eq(schema.proofRecords.id, payment.id));

    // The transaction on the chain says something else, or came from somewhere else.
    const tx = chain.transactions.get(proof.batch!.txHash)!;
    chain.transactions.set(proof.batch!.txHash, { ...tx, input: proofData(fingerprint("another root")) });
    expect((await getProof(acme.owner, payment.id)).checks[3].passed).toBe(false);
    chain.transactions.set(proof.batch!.txHash, { ...tx, from: getAddress("0x1111111111111111111111111111111111111111") });
    expect((await getProof(acme.owner, payment.id)).verified).toBe(false);
    chain.transactions.set(proof.batch!.txHash, tx);
    chain.down = true;
    expect((await getProof(acme.owner, payment.id)).verified).toBe(false);
    chain.down = false;
    expect((await getProof(acme.owner, payment.id)).verified).toBe(true);
  });

  it("belongs to the organization whose record it is", async () => {
    const id = await engaged(acme, relay);
    await runProofs();
    const [payment] = (await records()).filter((record) => record.engagementId === id && record.kind === "payment");
    expect((await getProof(acmeMember, payment.id)).state).toBe("confirmed");
    for (const other of [globex.owner, relay.owner, stranger]) {
      await expect(getProof(other, payment.id)).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(getProof(null, payment.id)).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(getProof(acme.owner, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await expect(listProofs(globex.owner, acme.org, "payment", [payment.entityId])).rejects.toMatchObject({ code: "forbidden" });
    // Asking for someone else's record by its id, through your own organization, finds nothing.
    expect((await listProofs(globex.owner, globex.org, "payment", [payment.entityId])).size).toBe(0);
    expect((await listProofs(acme.owner, acme.org, "payment", ["not-an-id"])).size).toBe(0);
  });
});
