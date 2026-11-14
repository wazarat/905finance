import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type { PaymentRail } from "@/db/schema";
import { getRail } from "@/lib/capabilities";
import type { AssetInfo } from "@/lib/units";
import { requirePermission, type Actor } from "./authz";

const {
  paymentAttempts,
  paymentTransactions,
  purchases,
  engagements,
  sellerProfiles,
  projects,
  spendingMandates,
} = schema;

export type PaymentLine = {
  id: string;
  engagementId: string;
  sellerName: string;
  projectName: string;
  offeringName: string;
  rail: PaymentRail;
  asset: AssetInfo;
  amountUnits: bigint;
  status: "initiated" | "succeeded" | "failed" | "uncertain";
  /** The provider's own reference for the payment, once it has one. */
  providerRef: string | null;
  provider: string;
  recipient: string;
  failureReason: string | null;
  isSimulated: boolean;
  verifiedAt: Date | null;
  createdAt: Date;
};

export type SpendingTotal = { asset: AssetInfo; rail: PaymentRail; spentUnits: bigint; isSimulated: boolean };

function assetFor(rail: PaymentRail, code: string, decimals: number | null): AssetInfo {
  return { code, decimals: decimals ?? getRail(rail)?.simulatedAsset.decimals ?? 2 };
}

/** Every payment attempt for an organization's engagements, with its provider reference. */
export async function listPayments(actor: Actor | null, organizationId: string): Promise<PaymentLine[]> {
  await requirePermission(actor, organizationId, "engagement.view");
  const rows = await getDb()
    .select({
      attempt: paymentAttempts,
      offeringName: purchases.offeringName,
      sellerName: sellerProfiles.displayName,
      projectName: projects.name,
      decimals: spendingMandates.assetDecimals,
      verifiedAt: paymentTransactions.verifiedAt,
    })
    .from(paymentAttempts)
    .innerJoin(purchases, eq(purchases.id, paymentAttempts.purchaseId))
    .innerJoin(engagements, eq(engagements.id, paymentAttempts.engagementId))
    .innerJoin(sellerProfiles, eq(sellerProfiles.id, engagements.sellerProfileId))
    .innerJoin(projects, eq(projects.id, engagements.projectId))
    .leftJoin(spendingMandates, eq(spendingMandates.engagementId, engagements.id))
    .leftJoin(paymentTransactions, eq(paymentTransactions.paymentAttemptId, paymentAttempts.id))
    .where(eq(engagements.organizationId, organizationId))
    .orderBy(desc(paymentAttempts.createdAt))
    .limit(200);

  return rows.map(({ attempt, offeringName, sellerName, projectName, decimals, verifiedAt }) => ({
    id: attempt.id,
    engagementId: attempt.engagementId,
    sellerName,
    projectName,
    offeringName,
    rail: attempt.rail,
    asset: assetFor(attempt.rail, attempt.asset, decimals),
    amountUnits: attempt.amountUnits,
    status: attempt.status,
    providerRef: attempt.providerRef,
    provider: attempt.provider,
    recipient: attempt.recipient,
    failureReason: attempt.failureReason,
    isSimulated: attempt.isSimulated,
    verifiedAt,
    createdAt: attempt.createdAt,
  }));
}

/** Confirmed spending per rail. Rails are never added together. */
export async function getSpendingTotals(
  actor: Actor | null,
  organizationId: string,
): Promise<SpendingTotal[]> {
  await requirePermission(actor, organizationId, "engagement.view");
  const rows = await getDb()
    .select({
      rail: paymentTransactions.rail,
      asset: paymentTransactions.asset,
      isSimulated: paymentTransactions.isSimulated,
      total: sql<string>`COALESCE(SUM(${paymentTransactions.amountUnits}), 0)::text`,
    })
    .from(paymentTransactions)
    .innerJoin(engagements, eq(engagements.id, paymentTransactions.engagementId))
    .where(eq(engagements.organizationId, organizationId))
    .groupBy(paymentTransactions.rail, paymentTransactions.asset, paymentTransactions.isSimulated);
  return rows.map((row) => ({
    rail: row.rail,
    asset: assetFor(row.rail, row.asset, null),
    spentUnits: BigInt(row.total),
    isSimulated: row.isSimulated,
  }));
}

export type SellerEarnings = {
  jobs: number;
  totals: SpendingTotal[];
  recent: Array<{
    id: string;
    offeringName: string;
    asset: AssetInfo;
    amountUnits: bigint;
    providerRef: string;
    isSimulated: boolean;
    createdAt: Date;
  }>;
};

/**
 * What a seller's listing has been paid, for the organization that owns it.
 * The buyer's identity, project and mandate are not part of this view.
 */
export async function getSellerEarnings(
  actor: Actor | null,
  organizationId: string,
): Promise<SellerEarnings | null> {
  await requirePermission(actor, organizationId, "seller_listing.view");
  const db = getDb();
  const [profile] = await db
    .select({ id: sellerProfiles.id })
    .from(sellerProfiles)
    .where(eq(sellerProfiles.organizationId, organizationId));
  if (!profile) return null;

  const rows = await db
    .select({ payment: paymentTransactions, offeringName: purchases.offeringName })
    .from(paymentTransactions)
    .innerJoin(purchases, eq(purchases.id, paymentTransactions.purchaseId))
    .where(eq(paymentTransactions.sellerProfileId, profile.id))
    .orderBy(desc(paymentTransactions.sequence));

  const totals = new Map<string, SpendingTotal>();
  for (const { payment } of rows) {
    const key = `${payment.rail}:${payment.asset}:${payment.isSimulated}`;
    const current = totals.get(key) ?? {
      rail: payment.rail,
      asset: assetFor(payment.rail, payment.asset, null),
      spentUnits: 0n,
      isSimulated: payment.isSimulated,
    };
    current.spentUnits += payment.amountUnits;
    totals.set(key, current);
  }
  return {
    jobs: rows.length,
    totals: [...totals.values()],
    recent: rows.slice(0, 10).map(({ payment, offeringName }) => ({
      id: payment.id,
      offeringName,
      asset: assetFor(payment.rail, payment.asset, null),
      amountUnits: payment.amountUnits,
      providerRef: payment.providerRef,
      isSimulated: payment.isSimulated,
      createdAt: payment.createdAt,
    })),
  };
}
