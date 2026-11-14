import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, schema, type DbOrTx } from "@/db/client";
import type {
  EngagementState,
  MasterWalletAccount,
  PaymentRail,
  WalletStatus,
} from "@/db/schema";
import { PAYMENT_RAIL_KEYS } from "@/lib/capabilities";
import { formatUnits, parseUnits, type AssetInfo } from "@/lib/units";
import { recordAudit } from "./audit";
import { assertAuthenticated, requirePermission, type Actor } from "./authz";
import { forbidden, invalid } from "./errors";
import { depositInput, parseInput } from "./validation";
import { getWalletProvider } from "./wallets/registry";

const {
  masterWalletAccounts,
  engagementWallets,
  engagements,
  walletLedgerEntries,
  sellerProfiles,
  projects,
  buyerProfiles,
} = schema;

/** Upper bound on a single simulated deposit, in whole asset units. */
const MAX_SIMULATED_DEPOSIT = 1_000_000n;

/**
 * The organization's master account on a rail, created on first use and
 * locked for the rest of the transaction.
 */
export async function ensureMasterAccount(
  tx: DbOrTx,
  organizationId: string,
  rail: PaymentRail,
): Promise<MasterWalletAccount> {
  const provider = getWalletProvider(rail);
  const find = () =>
    tx
      .select()
      .from(masterWalletAccounts)
      .where(
        and(
          eq(masterWalletAccounts.organizationId, organizationId),
          eq(masterWalletAccounts.rail, rail),
        ),
      )
      .for("update");

  const [existing] = await find();
  if (existing) return existing;

  const { providerRef } = await provider.connectMasterAccount({ organizationId });
  await tx
    .insert(masterWalletAccounts)
    .values({
      organizationId,
      rail,
      asset: provider.asset.code,
      assetDecimals: provider.asset.decimals,
      provider: provider.name,
      providerRef,
      isSimulated: provider.simulated,
    })
    .onConflictDoNothing();
  const [created] = await find();
  if (!created) throw new Error("Master account could not be created.");
  return created;
}

/**
 * Add simulated funds to a master account so funding can be exercised before
 * any real rail is connected. Refused for an account that holds real assets.
 */
export async function depositSimulatedFunds(
  actor: Actor | null,
  organizationId: string,
  rawInput: unknown,
): Promise<MasterWalletAccount> {
  await requirePermission(actor, organizationId, "wallet.manage");
  assertAuthenticated(actor);
  const input = parseInput(depositInput, rawInput);
  const provider = getWalletProvider(input.rail);
  if (!provider.simulated) {
    throw forbidden("Simulated funds cannot be added to a real account.");
  }
  const amount = parseUnits(input.amount, provider.asset.decimals);
  const cap = MAX_SIMULATED_DEPOSIT * 10n ** BigInt(provider.asset.decimals);
  if (amount === null || amount <= 0n) {
    throw invalid("Check the highlighted fields.", { amount: ["Enter an amount such as 1000."] });
  }
  if (amount > cap) {
    throw invalid("Check the highlighted fields.", {
      amount: [`Enter at most ${formatUnits(cap, provider.asset)} at a time.`],
    });
  }

  return getDb().transaction(async (tx) => {
    const [buyer] = await tx
      .select({ id: buyerProfiles.id })
      .from(buyerProfiles)
      .where(eq(buyerProfiles.organizationId, organizationId));
    if (!buyer) throw forbidden("Enable buying for this organization first.");

    const account = await ensureMasterAccount(tx, organizationId, input.rail);
    if (!account.isSimulated) {
      throw forbidden("Simulated funds cannot be added to a real account.");
    }
    const [updated] = await tx
      .update(masterWalletAccounts)
      .set({ balanceUnits: sql`${masterWalletAccounts.balanceUnits} + ${amount.toString()}::numeric` })
      .where(eq(masterWalletAccounts.id, account.id))
      .returning();
    await tx.insert(walletLedgerEntries).values({
      organizationId,
      rail: input.rail,
      masterWalletAccountId: account.id,
      kind: "simulated_deposit",
      deltaUnits: amount,
      balanceAfterUnits: updated.balanceUnits,
      actorUserId: actor.userId,
    });
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId,
        action: "master_wallet.simulated_deposit",
        entityType: "master_wallet_account",
        entityId: account.id,
        metadata: { rail: input.rail, asset: account.asset, amountUnits: amount.toString() },
      },
      tx,
    );
    return updated;
  });
}

export type RailOverview = {
  rail: PaymentRail;
  asset: AssetInfo;
  simulated: boolean;
  /** Null until the organization's account on this rail has been set up. */
  masterAccountId: string | null;
  /** Funds in the master account, not allocated to any engagement. */
  unallocatedUnits: bigint;
  /** Funds sitting in engagement wallets on this rail. */
  allocatedUnits: bigint;
};

export type EngagementWalletSummary = {
  id: string;
  engagementId: string;
  rail: PaymentRail;
  asset: AssetInfo;
  status: WalletStatus;
  balanceUnits: bigint;
  providerRef: string;
  isSimulated: boolean;
  engagementState: EngagementState;
  sellerName: string;
  projectName: string;
  createdAt: Date;
};

export type LedgerLine = {
  id: string;
  rail: PaymentRail;
  asset: AssetInfo;
  kind: "simulated_deposit" | "funding_debit" | "funding_credit" | "payment_debit";
  account: "master" | "engagement";
  deltaUnits: bigint;
  balanceAfterUnits: bigint;
  engagementId: string | null;
  createdAt: Date;
};

export type WalletOverview = {
  rails: RailOverview[];
  wallets: EngagementWalletSummary[];
  ledger: LedgerLine[];
};

/** Master accounts and engagement wallets, kept separate by rail. */
export async function getWalletOverview(
  actor: Actor | null,
  organizationId: string,
): Promise<WalletOverview> {
  await requirePermission(actor, organizationId, "wallet.view");
  const db = getDb();

  const masters = await db
    .select()
    .from(masterWalletAccounts)
    .where(eq(masterWalletAccounts.organizationId, organizationId));

  const walletRows = await db
    .select({
      wallet: engagementWallets,
      engagementState: engagements.state,
      sellerName: sellerProfiles.displayName,
      projectName: projects.name,
    })
    .from(engagementWallets)
    .innerJoin(engagements, eq(engagements.id, engagementWallets.engagementId))
    .innerJoin(sellerProfiles, eq(sellerProfiles.id, engagements.sellerProfileId))
    .innerJoin(projects, eq(projects.id, engagements.projectId))
    .where(eq(engagementWallets.organizationId, organizationId))
    .orderBy(desc(engagementWallets.createdAt));

  const wallets: EngagementWalletSummary[] = walletRows.map((row) => ({
    id: row.wallet.id,
    engagementId: row.wallet.engagementId,
    rail: row.wallet.rail,
    asset: { code: row.wallet.asset, decimals: row.wallet.assetDecimals },
    status: row.wallet.status,
    balanceUnits: row.wallet.balanceUnits,
    providerRef: row.wallet.providerRef,
    isSimulated: row.wallet.isSimulated,
    engagementState: row.engagementState,
    sellerName: row.sellerName,
    projectName: row.projectName,
    createdAt: row.wallet.createdAt,
  }));

  const rails: RailOverview[] = PAYMENT_RAIL_KEYS.map((rail) => {
    const provider = getWalletProvider(rail);
    const master = masters.find((m) => m.rail === rail);
    return {
      rail,
      asset: master ? { code: master.asset, decimals: master.assetDecimals } : provider.asset,
      simulated: master ? master.isSimulated : provider.simulated,
      masterAccountId: master?.id ?? null,
      unallocatedUnits: master?.balanceUnits ?? 0n,
      // Summed per rail only: balances on different rails are never added together.
      allocatedUnits: wallets
        .filter((w) => w.rail === rail)
        .reduce((sum, w) => sum + w.balanceUnits, 0n),
    };
  });

  const ledgerRows = await db
    .select({
      entry: walletLedgerEntries,
      walletEngagementId: engagementWallets.engagementId,
      walletAsset: engagementWallets.asset,
      walletDecimals: engagementWallets.assetDecimals,
      masterAsset: masterWalletAccounts.asset,
      masterDecimals: masterWalletAccounts.assetDecimals,
    })
    .from(walletLedgerEntries)
    .leftJoin(engagementWallets, eq(engagementWallets.id, walletLedgerEntries.engagementWalletId))
    .leftJoin(
      masterWalletAccounts,
      eq(masterWalletAccounts.id, walletLedgerEntries.masterWalletAccountId),
    )
    .where(eq(walletLedgerEntries.organizationId, organizationId))
    .orderBy(desc(walletLedgerEntries.sequence))
    .limit(20);

  const ledger: LedgerLine[] = ledgerRows.map((row) => ({
    id: row.entry.id,
    rail: row.entry.rail,
    asset: {
      code: row.walletAsset ?? row.masterAsset ?? "",
      decimals: row.walletDecimals ?? row.masterDecimals ?? 0,
    },
    kind: row.entry.kind,
    account: row.entry.masterWalletAccountId ? "master" : "engagement",
    deltaUnits: row.entry.deltaUnits,
    balanceAfterUnits: row.entry.balanceAfterUnits,
    engagementId: row.walletEngagementId,
    createdAt: row.entry.createdAt,
  }));

  return { rails, wallets, ledger };
}
