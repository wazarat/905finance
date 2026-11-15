import "server-only";
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { concatHex, getAddress, keccak256, stringToBytes, type Address, type Hash, type Hex } from "viem";
import { getDb, schema } from "@/db/client";
import type { ProofBatch, ProofRecord } from "@/db/schema";
import { GOAT_TESTNET3, displayReference, isEvmAddress, isTxHash } from "@/lib/goat";
import { assetLabel } from "@/lib/units";
import { assertAuthenticated, isUuid, requirePermission, requirePermissionOnRecord, type Actor } from "./authz";
import { privyServerConfig, type PrivyServerConfig } from "./env";
import { notFound } from "./errors";
import { gasBalance, goatClient, verifyNote } from "./goat/chain";
import { goatSigner } from "./goat/signer";

const {
  engagementRatings,
  engagements,
  fundReturns,
  fundingAuthorizations,
  paymentTransactions,
  platformWallets,
  proofBatches,
  proofRecords,
  validationCases,
} = schema;

/**
 * Proof on GOAT.
 *
 * Every payment, funding, return, rating and verdict is given a fingerprint:
 * the keccak256 hash of a short document describing it. Fingerprints are
 * combined in batches, and each batch's combined fingerprint is written to
 * GOAT Testnet3 in a transaction from the platform's proof wallet to itself.
 * Anyone holding a record's document can then check, against the chain alone,
 * that the record existed in exactly that form when the transaction was made.
 *
 * This proves a record, not a movement of money. A payment made in test funds
 * stays a payment in test funds: what is on the chain is its fingerprint.
 * Writing a fingerprint moves nothing, so unlike a payment it may be repeated
 * freely, and a batch that fails just releases its records to the next one.
 */

export const PROOF_KINDS = ["payment", "funding", "return", "rating", "verdict"] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];

/** The four bytes that begin every proof transaction's data: the text "905f". */
export const PROOF_PREFIX: Hex = "0x39303566";
const BATCH_SIZE = 100;
const SENDING_TIMEOUT_MS = 2 * 60_000;
const UNMINED_TIMEOUT_MS = 20 * 60_000;
/** Generous for a transfer to oneself with 36 bytes of data. */
const NOTE_GAS = 40_000n;

export type ProofConfig = { privy: PrivyServerConfig; walletPolicyId: null };

/** What is still missing before fingerprints can be written to GOAT, for an operator. */
export function proofGaps(): string[] {
  const gaps: string[] = [];
  if (process.env.GOAT_PROOFS !== "testnet3") gaps.push('GOAT_PROOFS set to "testnet3"');
  if (!privyServerConfig()) gaps.push("NEXT_PUBLIC_PRIVY_APP_ID and PRIVY_APP_SECRET");
  return gaps;
}

export function proofConfig(): ProofConfig | null {
  const privy = privyServerConfig();
  return process.env.GOAT_PROOFS === "testnet3" && privy ? { privy, walletPolicyId: null } : null;
}

export const fingerprint = (document: string): Hash => keccak256(stringToBytes(document));

/** The combined fingerprint of a batch: the hash of its members' fingerprints, in order. */
export function batchRoot(hashes: readonly string[]): Hash {
  return keccak256(concatHex(hashes as Hex[]));
}

export const proofData = (root: string): Hex => concatHex([PROOF_PREFIX, root as Hex]);

// ---------------------------------------------------------------------------
// Fingerprinting records
// ---------------------------------------------------------------------------

const settlementOf = (isSimulated: boolean) => (isSimulated ? "test funds" : GOAT_TESTNET3.name);

type Draft = { organizationId: string; engagementId: string | null; kind: ProofKind; entityId: string; document: string };

/**
 * Give a fingerprint to every settled record that does not have one yet. The
 * records it reads are final: a confirmed payment, an executed funding or
 * return, a rating, a decided case. Returns how many were added.
 */
export async function syncProofRecords(): Promise<number> {
  const db = getDb();
  const missing = (kind: ProofKind, column: unknown) =>
    sql`not exists (select 1 from ${proofRecords} where ${proofRecords.kind} = ${kind} and ${proofRecords.entityId} = ${column})`;
  const drafts: Draft[] = [];

  const payments = await db
    .select({ payment: paymentTransactions, organizationId: engagements.organizationId })
    .from(paymentTransactions)
    .innerJoin(engagements, eq(engagements.id, paymentTransactions.engagementId))
    .where(missing("payment", paymentTransactions.paymentAttemptId))
    .orderBy(paymentTransactions.sequence)
    .limit(BATCH_SIZE);
  for (const { payment, organizationId } of payments) {
    drafts.push({
      organizationId,
      engagementId: payment.engagementId,
      kind: "payment",
      entityId: payment.paymentAttemptId,
      document: JSON.stringify({
        type: "905finance.payment.v1",
        id: payment.paymentAttemptId,
        engagement: payment.engagementId,
        seller: payment.sellerProfileId,
        asset: assetLabel(payment.asset),
        amountUnits: payment.amountUnits.toString(),
        paidTo: displayReference(payment.recipient),
        reference: displayReference(payment.providerRef),
        settledIn: settlementOf(payment.isSimulated),
        at: payment.verifiedAt.toISOString(),
      }),
    });
  }

  const fundings = await db
    .select({ funding: fundingAuthorizations, organizationId: engagements.organizationId })
    .from(fundingAuthorizations)
    .innerJoin(engagements, eq(engagements.id, fundingAuthorizations.engagementId))
    .where(and(eq(fundingAuthorizations.status, "executed"), missing("funding", fundingAuthorizations.id)))
    .orderBy(fundingAuthorizations.authorizedAt)
    .limit(BATCH_SIZE);
  for (const { funding, organizationId } of fundings) {
    drafts.push({
      organizationId,
      engagementId: funding.engagementId,
      kind: "funding",
      entityId: funding.id,
      document: JSON.stringify({
        type: "905finance.funding.v1",
        id: funding.id,
        engagement: funding.engagementId,
        asset: assetLabel(funding.asset),
        amountUnits: funding.amountUnits.toString(),
        reference: funding.providerRef ? displayReference(funding.providerRef) : null,
        settledIn: settlementOf(funding.isSimulated),
        at: (funding.executedAt ?? funding.authorizedAt).toISOString(),
      }),
    });
  }

  const returns = await db
    .select({ returned: fundReturns, organizationId: engagements.organizationId })
    .from(fundReturns)
    .innerJoin(engagements, eq(engagements.id, fundReturns.engagementId))
    .where(and(eq(fundReturns.status, "executed"), missing("return", fundReturns.id)))
    .orderBy(fundReturns.authorizedAt)
    .limit(BATCH_SIZE);
  for (const { returned, organizationId } of returns) {
    drafts.push({
      organizationId,
      engagementId: returned.engagementId,
      kind: "return",
      entityId: returned.id,
      document: JSON.stringify({
        type: "905finance.return.v1",
        id: returned.id,
        engagement: returned.engagementId,
        asset: assetLabel(returned.asset),
        amountUnits: returned.amountUnits.toString(),
        reference: returned.providerRef ? displayReference(returned.providerRef) : null,
        settledIn: settlementOf(returned.isSimulated),
        at: (returned.executedAt ?? returned.authorizedAt).toISOString(),
      }),
    });
  }

  const ratings = await db
    .select()
    .from(engagementRatings)
    .where(missing("rating", engagementRatings.id))
    .orderBy(engagementRatings.createdAt)
    .limit(BATCH_SIZE);
  for (const rating of ratings) {
    drafts.push({
      organizationId: rating.organizationId,
      engagementId: rating.engagementId,
      kind: "rating",
      entityId: rating.id,
      // The comment is private and is not part of the fingerprint's document.
      document: JSON.stringify({
        type: "905finance.rating-record.v1",
        id: rating.id,
        engagement: rating.engagementId,
        seller: rating.sellerProfileId,
        stars: rating.stars,
        feedbackHash: rating.feedbackHash,
        at: rating.createdAt.toISOString(),
      }),
    });
  }

  const verdicts = await db
    .select()
    .from(validationCases)
    .where(and(inArray(validationCases.status, ["upheld", "not_upheld"]), missing("verdict", validationCases.id)))
    .orderBy(validationCases.decidedAt)
    .limit(BATCH_SIZE);
  for (const decided of verdicts) {
    drafts.push({
      organizationId: decided.organizationId,
      engagementId: decided.engagementId,
      kind: "verdict",
      entityId: decided.id,
      document: JSON.stringify({
        type: "905finance.verdict.v1",
        id: decided.id,
        engagement: decided.engagementId,
        seller: decided.sellerProfileId,
        requestHash: decided.requestHash,
        verdict: decided.status,
        score: decided.score,
        at: decided.decidedAt?.toISOString() ?? null,
      }),
    });
  }

  if (drafts.length === 0) return 0;
  const inserted = await db
    .insert(proofRecords)
    .values(drafts.map((draft) => ({ ...draft, recordHash: fingerprint(draft.document) })))
    .onConflictDoNothing({ target: [proofRecords.kind, proofRecords.entityId] })
    .returning({ id: proofRecords.id });
  return inserted.length;
}

// ---------------------------------------------------------------------------
// Writing fingerprints to GOAT
// ---------------------------------------------------------------------------

const PROOF_WALLET = "proofs";

/** The platform's proof wallet, created with the custody provider the first time it is needed. */
async function proofWallet(config: ProofConfig): Promise<{ custodyRef: string; address: Address }> {
  const db = getDb();
  const [existing] = await db.select().from(platformWallets).where(eq(platformWallets.purpose, PROOF_WALLET));
  if (existing) return { custodyRef: existing.custodyRef, address: getAddress(existing.address) };
  const created = await goatSigner(config).createWallet({ externalId: "905finance-proofs-v1", unrestricted: true });
  await db
    .insert(platformWallets)
    .values({ purpose: PROOF_WALLET, custodyRef: created.id, address: created.address })
    .onConflictDoNothing({ target: platformWallets.purpose });
  const [saved] = await db.select().from(platformWallets).where(eq(platformWallets.purpose, PROOF_WALLET));
  return { custodyRef: saved.custodyRef, address: getAddress(saved.address) };
}

async function failBatch(batchId: string, reason: string): Promise<void> {
  const db = getDb();
  await db
    .update(proofBatches)
    .set({ status: "failed", failureReason: reason.slice(0, 500) })
    .where(eq(proofBatches.id, batchId));
  // Its records go back to waiting, and are picked up by the next batch.
  await db.update(proofRecords).set({ batchId: null }).where(eq(proofRecords.batchId, batchId));
}

/** Ask the chain about every batch that was sent and is not settled yet. */
async function settleBatches(): Promise<void> {
  const db = getDb();
  const sent = await db.select().from(proofBatches).where(eq(proofBatches.status, "sent"));
  for (const batch of sent) {
    if (!isTxHash(batch.txHash) || !batch.root || !isEvmAddress(batch.walletAddress)) {
      await failBatch(batch.id, "The batch was recorded without its transaction.");
      continue;
    }
    const result = await verifyNote({
      hash: batch.txHash,
      wallet: getAddress(batch.walletAddress),
      data: proofData(batch.root),
    });
    if (result.ok) {
      await db
        .update(proofBatches)
        .set({ status: "confirmed", blockNumber: result.blockNumber, confirmedAt: new Date(), failureReason: null })
        .where(eq(proofBatches.id, batch.id));
    } else if (!result.pending) {
      await failBatch(batch.id, result.reason);
    } else if (batch.sentAt && Date.now() - batch.sentAt.getTime() > UNMINED_TIMEOUT_MS) {
      await failBatch(batch.id, "The transaction was never included in a block.");
    }
  }
}

export type ProofRun = {
  state: "off" | "idle" | "unfunded" | "busy" | "sent" | "failed";
  /** Records given a fingerprint in this run. */
  added: number;
  /** Records in the batch this run sent, if it sent one. */
  sent: number;
  detail?: string;
};

async function writeBatch(config: ProofConfig): Promise<Omit<ProofRun, "added">> {
  const db = getDb();
  // A batch left half-made by a request that died gives its place up.
  const stale = await db
    .select({ id: proofBatches.id })
    .from(proofBatches)
    .where(and(eq(proofBatches.status, "sending"), lt(proofBatches.createdAt, new Date(Date.now() - SENDING_TIMEOUT_MS))));
  for (const batch of stale) await failBatch(batch.id, "The batch was not sent in time.");

  const [waiting] = await db.select({ id: proofRecords.id }).from(proofRecords).where(isNull(proofRecords.batchId)).limit(1);
  if (!waiting) return { state: "idle", sent: 0 };

  const wallet = await proofWallet(config);
  const fee = (await goatClient().getGasPrice()) * NOTE_GAS;
  if ((await gasBalance(wallet.address)) < fee) {
    return {
      state: "unfunded",
      sent: 0,
      detail: `The proof wallet ${wallet.address} has no ${GOAT_TESTNET3.nativeCurrency.symbol} to pay the network fee.`,
    };
  }

  let batch: ProofBatch;
  try {
    [batch] = await db.insert(proofBatches).values({ walletAddress: wallet.address }).returning();
  } catch {
    // Another request is putting a batch together right now. It will take these records, or the next run will.
    return { state: "busy", sent: 0 };
  }
  const candidates = await db
    .select({ id: proofRecords.id })
    .from(proofRecords)
    .where(isNull(proofRecords.batchId))
    .orderBy(proofRecords.sequence)
    .limit(BATCH_SIZE);
  const members = await db
    .update(proofRecords)
    .set({ batchId: batch.id })
    .where(and(inArray(proofRecords.id, candidates.map((entry) => entry.id)), isNull(proofRecords.batchId)))
    .returning({ sequence: proofRecords.sequence, recordHash: proofRecords.recordHash });
  if (members.length === 0) {
    await db.delete(proofBatches).where(eq(proofBatches.id, batch.id));
    return { state: "idle", sent: 0 };
  }
  members.sort((a, b) => a.sequence - b.sequence);
  const root = batchRoot(members.map((member) => member.recordHash));
  await db.update(proofBatches).set({ root, recordCount: members.length }).where(eq(proofBatches.id, batch.id));

  let hash: Hash;
  try {
    hash = await goatSigner(config).sendNote({ walletId: wallet.custodyRef, from: wallet.address, data: proofData(root) });
  } catch (error) {
    console.error("A proof batch could not be sent", error);
    await failBatch(batch.id, "The transaction could not be sent.");
    return { state: "failed", sent: 0, detail: "The transaction could not be sent. It will be tried again." };
  }
  await db
    .update(proofBatches)
    .set({ status: "sent", txHash: hash, sentAt: new Date() })
    .where(eq(proofBatches.id, batch.id));
  return { state: "sent", sent: members.length };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The same as `runProofs`, and then, if a batch was sent, a short wait for the
 * chain to put blocks on top of it before recording that it settled. For work
 * done after a response has gone out, where waiting costs nobody anything.
 */
export async function runProofsAndSettle(waitMs = 8_000): Promise<ProofRun> {
  const outcome = await runProofs();
  if (outcome.state === "sent") {
    try {
      await sleep(waitMs);
      await settleBatches();
    } catch (error) {
      console.error("A proof batch could not be settled yet", error);
    }
  }
  return outcome;
}

/** Settle what was sent, without sending anything. Never throws. */
export async function settleProofs(waitMs = 0): Promise<void> {
  try {
    if (waitMs > 0) await sleep(waitMs);
    await settleBatches();
  } catch (error) {
    console.error("Proof batches could not be settled yet", error);
  }
}

/**
 * Fingerprint what is new, settle what was sent, and send what is waiting.
 * Called after anything that settles a record, and on request. It never
 * throws: a proof that could not be written now is written on the next run.
 */
export async function runProofs(): Promise<ProofRun> {
  let added = 0;
  try {
    added = await syncProofRecords();
    const config = proofConfig();
    if (!config) return { state: "off", added, sent: 0 };
    await settleBatches();
    const outcome = await writeBatch(config);
    if (outcome.state === "sent") await settleBatches();
    return { ...outcome, added };
  } catch (error) {
    console.error("Proofs could not be run", error);
    return { state: "failed", added, sent: 0, detail: "GOAT Network or the wallet provider could not be reached." };
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type ProofState = "confirmed" | "sent" | "waiting";
export type ProofTagData = { recordId: string; state: ProofState; txHash: string | null };

function stateOf(batch: ProofBatch | null): ProofState {
  return batch?.status === "confirmed" ? "confirmed" : batch?.status === "sent" ? "sent" : "waiting";
}

/** The proofs for some of an organization's records, by the record's own id. */
export async function listProofs(
  actor: Actor | null,
  organizationId: string,
  kind: ProofKind,
  entityIds: string[],
): Promise<Map<string, ProofTagData>> {
  await requirePermission(actor, organizationId, "engagement.view");
  const ids = entityIds.filter(isUuid);
  const found = new Map<string, ProofTagData>();
  if (ids.length === 0) return found;
  const rows = await getDb()
    .select({ record: proofRecords, batch: proofBatches })
    .from(proofRecords)
    .leftJoin(proofBatches, eq(proofBatches.id, proofRecords.batchId))
    .where(
      and(eq(proofRecords.organizationId, organizationId), eq(proofRecords.kind, kind), inArray(proofRecords.entityId, ids)),
    );
  for (const { record, batch } of rows) {
    found.set(record.entityId, { recordId: record.id, state: stateOf(batch), txHash: batch?.txHash ?? null });
  }
  return found;
}

export type ProofCheck = { label: string; passed: boolean };

export type ProofDetail = {
  record: ProofRecord;
  state: ProofState;
  batch: {
    root: string;
    txHash: string;
    blockNumber: string | null;
    walletAddress: string;
    data: string;
    /** Every fingerprint in the batch, in order. The record's own is at `position`. */
    hashes: string[];
    position: number;
    confirmedAt: Date | null;
  } | null;
  /** Each step of checking the proof, done again now. Empty while the proof is not on the chain. */
  checks: ProofCheck[];
  verified: boolean;
};

/** One record's proof, checked again against the chain as it is read. */
export async function getProof(actor: Actor | null, recordId: string): Promise<ProofDetail> {
  assertAuthenticated(actor);
  if (!isUuid(recordId)) throw notFound("Proof");
  const db = getDb();
  const [record] = await db.select().from(proofRecords).where(eq(proofRecords.id, recordId));
  await requirePermissionOnRecord(actor, record, "engagement.view", "Proof");
  const [batch] = record.batchId ? await db.select().from(proofBatches).where(eq(proofBatches.id, record.batchId)) : [];
  if (!batch || !batch.root || !isTxHash(batch.txHash) || (batch.status !== "confirmed" && batch.status !== "sent")) {
    return { record, state: "waiting", batch: null, checks: [], verified: false };
  }
  const members = await db
    .select({ id: proofRecords.id, recordHash: proofRecords.recordHash })
    .from(proofRecords)
    .where(eq(proofRecords.batchId, batch.id))
    .orderBy(proofRecords.sequence);
  const hashes = members.map((member) => member.recordHash);
  const data = proofData(batch.root);
  const checks: ProofCheck[] = [
    { label: "The document's keccak256 hash is the record's fingerprint", passed: fingerprint(record.document) === record.recordHash },
    { label: "The fingerprint is one of the batch's", passed: hashes.includes(record.recordHash) },
    { label: "The batch's fingerprints hash to the combined fingerprint", passed: batchRoot(hashes) === batch.root },
  ];
  let onChain = false;
  let current = batch;
  try {
    const result = await verifyNote({ hash: batch.txHash, wallet: getAddress(batch.walletAddress), data });
    onChain = result.ok;
    // The chain has settled it since it was sent: record that now, rather than wait for the next run.
    if (result.ok && batch.status === "sent") {
      const [settled] = await db
        .update(proofBatches)
        .set({ status: "confirmed", blockNumber: result.blockNumber, confirmedAt: new Date(), failureReason: null })
        .where(and(eq(proofBatches.id, batch.id), eq(proofBatches.status, "sent")))
        .returning();
      current = settled ?? batch;
    }
  } catch {
    onChain = false;
  }
  checks.push({
    label: `The transaction on ${GOAT_TESTNET3.name} carries the combined fingerprint, and has settled`,
    passed: onChain,
  });
  return {
    record,
    state: stateOf(current),
    batch: {
      root: batch.root,
      txHash: batch.txHash,
      blockNumber: current.blockNumber?.toString() ?? null,
      walletAddress: batch.walletAddress,
      data,
      hashes,
      position: hashes.indexOf(record.recordHash),
      confirmedAt: current.confirmedAt,
    },
    checks,
    verified: checks.every((check) => check.passed),
  };
}

export type ProofStatus = {
  enabled: boolean;
  gaps: string[];
  walletAddress: string | null;
  funded: boolean | null;
  waiting: number;
  confirmed: number;
  lastConfirmed: { txHash: string; at: Date } | null;
};

/** Where proofs stand for the whole deployment. Nothing here is specific to one organization. */
export async function getProofStatus(): Promise<ProofStatus> {
  const db = getDb();
  const [wallet] = await db.select().from(platformWallets).where(eq(platformWallets.purpose, PROOF_WALLET));
  const [counts] = await db
    .select({
      waiting: sql<number>`count(*) filter (where ${proofBatches.status} is distinct from 'confirmed')::int`,
      confirmed: sql<number>`count(*) filter (where ${proofBatches.status} = 'confirmed')::int`,
    })
    .from(proofRecords)
    .leftJoin(proofBatches, eq(proofBatches.id, proofRecords.batchId));
  const [last] = await db
    .select()
    .from(proofBatches)
    .where(eq(proofBatches.status, "confirmed"))
    .orderBy(desc(proofBatches.confirmedAt))
    .limit(1);
  let funded: boolean | null = null;
  if (wallet && proofConfig()) {
    try {
      funded = (await gasBalance(getAddress(wallet.address))) >= (await goatClient().getGasPrice()) * NOTE_GAS;
    } catch {
      funded = null;
    }
  }
  return {
    enabled: proofConfig() !== null,
    gaps: proofGaps(),
    walletAddress: wallet?.address ?? null,
    funded,
    waiting: counts?.waiting ?? 0,
    confirmed: counts?.confirmed ?? 0,
    lastConfirmed: last?.txHash && last.confirmedAt ? { txHash: last.txHash, at: last.confirmedAt } : null,
  };
}
