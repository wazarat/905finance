import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { schema, type DbOrTx } from "@/db/client";
import type { ServiceOffering } from "@/db/schema";
import type { AssetInfo } from "@/lib/units";

const { spendingMandates, spendingReservations, engagementWallets } = schema;

/**
 * Where an engagement's authority and money stand. Authority (the budget) and
 * money (the wallet) are tracked separately and a purchase needs both.
 */
export type BudgetStatus = {
  mandateId: string;
  asset: AssetInfo;
  totalUnits: bigint;
  perTransactionUnits: bigint;
  /** Confirmed payments. */
  spentUnits: bigint;
  /** Set aside for purchases whose payment has not been confirmed yet. */
  reservedUnits: bigint;
  /** Budget still free to reserve: total minus spent minus reserved. */
  remainingUnits: bigint;
  walletBalanceUnits: bigint;
  /** Wallet balance not already promised to a pending payment. */
  walletAvailableUnits: bigint;
};

export async function getBudgetStatus(db: DbOrTx, engagementId: string): Promise<BudgetStatus | null> {
  const [mandate] = await db
    .select()
    .from(spendingMandates)
    .where(eq(spendingMandates.engagementId, engagementId));
  if (!mandate) return null;

  const sums = await db
    .select({
      status: spendingReservations.status,
      total: sql<string>`COALESCE(SUM(${spendingReservations.amountUnits}), 0)::text`,
    })
    .from(spendingReservations)
    .where(eq(spendingReservations.mandateId, mandate.id))
    .groupBy(spendingReservations.status);
  const sumOf = (status: string) => BigInt(sums.find((s) => s.status === status)?.total ?? "0");
  const spentUnits = sumOf("committed");
  const reservedUnits = sumOf("held");

  const [wallet] = await db
    .select({ balanceUnits: engagementWallets.balanceUnits })
    .from(engagementWallets)
    .where(and(eq(engagementWallets.engagementId, engagementId)));
  const walletBalanceUnits = wallet?.balanceUnits ?? 0n;

  return {
    mandateId: mandate.id,
    asset: { code: mandate.asset, decimals: mandate.assetDecimals },
    totalUnits: mandate.totalAuthorizedUnits,
    perTransactionUnits: mandate.perTransactionLimitUnits,
    spentUnits,
    reservedUnits,
    remainingUnits: mandate.totalAuthorizedUnits - spentUnits - reservedUnits,
    walletBalanceUnits,
    walletAvailableUnits: walletBalanceUnits - reservedUnits,
  };
}

/**
 * The price of an offering in an asset's units. Listings are priced in USD
 * cents and the simulated assets stand in for a dollar at two or more
 * decimals, so this is an exact integer scaling. Returns null when a listing
 * cannot be expressed in the asset; real rails define their own conversion
 * when their integrations are built.
 */
export function offeringPriceUnits(
  offering: Pick<ServiceOffering, "priceMinor" | "currency">,
  asset: AssetInfo,
  quantity = 1,
): bigint | null {
  if (offering.currency !== "USD" || asset.decimals < 2 || quantity < 1) return null;
  return BigInt(offering.priceMinor) * 10n ** BigInt(asset.decimals - 2) * BigInt(quantity);
}
