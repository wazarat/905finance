import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import type {
  AgentStatus,
  BillingUnit,
  Engagement,
  EngagementState,
  FundingAuthorization,
  MandateStatus,
  OrgRole,
  PaymentRail,
  SpendingMandate,
  WalletStatus,
} from "@/db/schema";
import { ENGAGEMENT_STATE_LABELS, isTerminal, permitsFunding } from "@/lib/engagement-state";
import { formatUnits, parseUnits, type AssetInfo } from "@/lib/units";
import { recordAudit } from "./audit";
import {
  assertAuthenticated,
  isUuid,
  requirePermission,
  requirePermissionOnRecord,
  roleHasPermission,
  type Actor,
} from "./authz";
import { conflict, forbidden, invalid, notFound } from "./errors";
import { closeEngagement, settleExpired, transition, withEngagement } from "./engagement-core";
import { engagementInput, fundingInput, mandateInput, parseInput } from "./validation";
import { settleFundingRequest } from "./approvals";
import { getPaymentProvider, simulatedRecipient } from "./payments/registry";
import { ensureMasterAccount } from "./wallets";
import { getWalletProvider } from "./wallets/registry";

const {
  engagements,
  engagementEvents,
  spendingMandates,
  mandatePermittedOfferings,
  purchasingAgents,
  engagementWallets,
  masterWalletAccounts,
  fundingAuthorizations,
  walletLedgerEntries,
  sellerProfiles,
  serviceOfferings,
  projects,
  buyerProfiles,
  users,
} = schema;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What must be re-approved by the owner. Fixed for the MVP and recorded with each mandate. */
const APPROVAL_REQUIREMENTS = {
  budgetIncrease: "owner_approval",
  additionalFunding: "owner_authorization",
  scopeChange: "owner_approval",
} as const;

// ---------------------------------------------------------------------------
// Creating an engagement and selecting the seller
// ---------------------------------------------------------------------------

/**
 * Start an engagement for a project with the seller a person picked. Selecting
 * a seller authorizes nothing: no agent exists, no wallet exists and the
 * seller is not contacted.
 */
export async function createEngagement(
  actor: Actor | null,
  organizationId: string,
  rawInput: unknown,
): Promise<Engagement> {
  await requirePermission(actor, organizationId, "engagement.draft");
  assertAuthenticated(actor);
  const input = parseInput(engagementInput, rawInput);

  return getDb().transaction(async (tx) => {
    const [buyer] = await tx
      .select({ id: buyerProfiles.id })
      .from(buyerProfiles)
      .where(eq(buyerProfiles.organizationId, organizationId));
    if (!buyer) throw forbidden("Enable buying for this organization first.");

    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.organizationId, organizationId)));
    if (!project) throw notFound("Project");

    const [seller] = await tx
      .select({ id: sellerProfiles.id, slug: sellerProfiles.slug })
      .from(sellerProfiles)
      .where(and(eq(sellerProfiles.slug, input.sellerSlug), eq(sellerProfiles.status, "active")));
    if (!seller) throw notFound("Seller");

    const [created] = await tx
      .insert(engagements)
      .values({ organizationId, projectId: project.id, createdBy: actor.userId })
      .returning();
    await tx.insert(engagementEvents).values({
      engagementId: created.id,
      fromState: null,
      toState: "DISCOVERING",
      actorUserId: actor.userId,
      note: "Engagement started.",
    });
    const selected = await transition(
      tx,
      created,
      "SELLER_SELECTED",
      actor.userId,
      "Seller selected by the buyer.",
      { sellerProfileId: seller.id },
    );
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId,
        action: "engagement.seller_selected",
        entityType: "engagement",
        entityId: selected.id,
        metadata: { seller: seller.slug, projectId: project.id },
      },
      tx,
    );
    return selected;
  });
}

// ---------------------------------------------------------------------------
// The spending mandate
// ---------------------------------------------------------------------------

/** Save the draft mandate. Allowed only before authorization; it grants nothing by itself. */
export async function saveMandateDraft(
  actor: Actor | null,
  engagementId: string,
  rawInput: unknown,
): Promise<SpendingMandate> {
  const input = parseInput(mandateInput, rawInput);

  return withEngagement(actor, engagementId, "engagement.draft", async (tx, engagement, who) => {
    if (engagement.state !== "SELLER_SELECTED" || !engagement.sellerProfileId) {
      throw conflict("The mandate can only be changed before the engagement is authorized.");
    }
    const [seller] = await tx
      .select()
      .from(sellerProfiles)
      .where(eq(sellerProfiles.id, engagement.sellerProfileId));
    if (!seller || seller.status !== "active") {
      throw conflict("This seller's listing is no longer active.");
    }
    if (!seller.intendedRails.includes(input.rail)) {
      throw invalid("Check the highlighted fields.", {
        rail: ["This seller does not accept that payment rail."],
      });
    }

    const asset = getWalletProvider(input.rail).asset;
    const total = parseUnits(input.totalBudget, asset.decimals);
    const perTransaction = parseUnits(input.perTransactionLimit, asset.decimals);
    const fieldErrors: Record<string, string[]> = {};
    if (total === null || total <= 0n) {
      fieldErrors.totalBudget = ["Enter an amount greater than zero, such as 100 or 100.00."];
    }
    if (perTransaction === null || perTransaction <= 0n) {
      fieldErrors.perTransactionLimit = ["Enter an amount greater than zero, such as 25 or 25.00."];
    }
    if (total !== null && perTransaction !== null && perTransaction > total) {
      fieldErrors.perTransactionLimit = ["The per-purchase limit cannot exceed the total budget."];
    }

    const offeringIds = [...new Set(input.offeringIds)];
    const offerings = await tx
      .select({ id: serviceOfferings.id })
      .from(serviceOfferings)
      .where(
        and(
          inArray(serviceOfferings.id, offeringIds),
          eq(serviceOfferings.sellerProfileId, seller.id),
          eq(serviceOfferings.isActive, true),
        ),
      );
    if (offerings.length !== offeringIds.length) {
      fieldErrors.offeringIds = ["Choose services that this seller currently offers."];
    }
    if (Object.keys(fieldErrors).length > 0 || total === null || perTransaction === null) {
      throw invalid("Check the highlighted fields.", fieldErrors);
    }

    const values = {
      sellerProfileId: seller.id,
      asset: asset.code,
      assetDecimals: asset.decimals,
      totalAuthorizedUnits: total,
      perTransactionLimitUnits: perTransaction,
      scope: input.scope,
      expiresAt: new Date(Date.now() + input.expiresInDays * DAY_MS),
      approvalRequirements: { ...APPROVAL_REQUIREMENTS },
    };
    const [existing] = await tx
      .select()
      .from(spendingMandates)
      .where(eq(spendingMandates.engagementId, engagement.id))
      .for("update");
    let mandate: SpendingMandate;
    if (existing) {
      if (existing.status !== "draft") {
        throw conflict("The mandate can only be changed before the engagement is authorized.");
      }
      [mandate] = await tx
        .update(spendingMandates)
        .set(values)
        .where(eq(spendingMandates.id, existing.id))
        .returning();
    } else {
      [mandate] = await tx
        .insert(spendingMandates)
        .values({ ...values, engagementId: engagement.id, createdBy: who.userId })
        .returning();
    }

    await tx
      .delete(mandatePermittedOfferings)
      .where(eq(mandatePermittedOfferings.mandateId, mandate.id));
    await tx
      .insert(mandatePermittedOfferings)
      .values(offeringIds.map((serviceOfferingId) => ({ mandateId: mandate.id, serviceOfferingId })));
    await tx.update(engagements).set({ rail: input.rail }).where(eq(engagements.id, engagement.id));

    await recordAudit(
      {
        actorUserId: who.userId,
        organizationId: engagement.organizationId,
        action: "mandate.drafted",
        entityType: "spending_mandate",
        entityId: mandate.id,
        metadata: {
          rail: input.rail,
          asset: asset.code,
          totalAuthorizedUnits: total.toString(),
          perTransactionLimitUnits: perTransaction.toString(),
          offerings: offeringIds.length,
        },
      },
      tx,
    );
    return mandate;
  });
}

/**
 * The buyer's explicit authorization of the engagement and its mandate. It
 * creates the purchasing agent in an inactive state. It does not provision a
 * wallet and it does not move any funds.
 */
export async function authorizeEngagement(
  actor: Actor | null,
  engagementId: string,
  confirmation: { confirmed: unknown },
): Promise<Engagement> {
  if (confirmation.confirmed !== true) {
    throw invalid("Confirm that you authorize this engagement.", {
      confirmed: ["Confirm that you authorize this engagement."],
    });
  }
  return withEngagement(actor, engagementId, "engagement.authorize", async (tx, engagement, who) => {
    if (engagement.state !== "SELLER_SELECTED" || !engagement.sellerProfileId) {
      throw conflict("This engagement has already been authorized or closed.");
    }
    const [mandate] = await tx
      .select()
      .from(spendingMandates)
      .where(eq(spendingMandates.engagementId, engagement.id))
      .for("update");
    if (!mandate || mandate.status !== "draft" || !engagement.rail) {
      throw invalid("Set the budget, services and scope before authorizing.");
    }
    if (mandate.sellerProfileId !== engagement.sellerProfileId) {
      throw conflict("The mandate does not match the selected seller.");
    }
    const now = new Date();
    if (mandate.expiresAt <= now) {
      throw invalid("The mandate's expiry has passed. Save the mandate again to set a new one.");
    }
    const [seller] = await tx
      .select({ status: sellerProfiles.status })
      .from(sellerProfiles)
      .where(eq(sellerProfiles.id, engagement.sellerProfileId));
    if (!seller || seller.status !== "active") {
      throw conflict("This seller's listing is no longer active.");
    }
    const permitted = await tx
      .select({ isActive: serviceOfferings.isActive })
      .from(mandatePermittedOfferings)
      .innerJoin(serviceOfferings, eq(serviceOfferings.id, mandatePermittedOfferings.serviceOfferingId))
      .where(eq(mandatePermittedOfferings.mandateId, mandate.id));
    if (permitted.length === 0 || permitted.some((o) => !o.isActive)) {
      throw invalid("One of the permitted services is no longer offered. Review the mandate.");
    }

    // The account the seller must be paid at is fixed here, by the buyer's
    // authorization. A seller cannot later ask to be paid somewhere else.
    const paymentProvider = getPaymentProvider(engagement.rail);
    await tx
      .update(spendingMandates)
      .set({
        status: "authorized",
        authorizedAt: now,
        authorizedBy: who.userId,
        authorizedRecipient: paymentProvider.simulated
          ? simulatedRecipient(engagement.rail, engagement.sellerProfileId)
          : null,
      })
      .where(eq(spendingMandates.id, mandate.id));
    await tx.insert(purchasingAgents).values({ engagementId: engagement.id, status: "inactive" });
    const authorized = await transition(
      tx,
      engagement,
      "AUTHORIZED",
      who.userId,
      "Engagement and spending mandate authorized by the buyer.",
      { authorizedAt: now, authorizedBy: who.userId, expiresAt: mandate.expiresAt },
    );
    await recordAudit(
      {
        actorUserId: who.userId,
        organizationId: engagement.organizationId,
        action: "engagement.authorized",
        entityType: "engagement",
        entityId: engagement.id,
        metadata: {
          rail: engagement.rail,
          asset: mandate.asset,
          totalAuthorizedUnits: mandate.totalAuthorizedUnits.toString(),
          perTransactionLimitUnits: mandate.perTransactionLimitUnits.toString(),
          expiresAt: mandate.expiresAt.toISOString(),
        },
      },
      tx,
    );
    return authorized;
  });
}

// ---------------------------------------------------------------------------
// The engagement wallet
// ---------------------------------------------------------------------------

/**
 * Provision the engagement's own wallet on its rail. Every engagement gets a
 * new one, even with a seller the buyer has used before. Provisioning moves
 * no funds: the wallet starts empty and waits for a separate funding decision.
 */
export async function provisionEngagementWallet(
  actor: Actor | null,
  engagementId: string,
): Promise<Engagement> {
  return withEngagement(actor, engagementId, "engagement.authorize", async (tx, engagement, who) => {
    if (engagement.state !== "AUTHORIZED" || !engagement.rail) {
      throw conflict("A wallet can only be provisioned for an authorized engagement that has none.");
    }
    const [already] = await tx
      .select({ id: engagementWallets.id })
      .from(engagementWallets)
      .where(eq(engagementWallets.engagementId, engagement.id));
    if (already) throw conflict("This engagement already has a wallet.");

    const provider = getWalletProvider(engagement.rail);
    await ensureMasterAccount(tx, engagement.organizationId, engagement.rail);

    let providerRef: string;
    try {
      ({ providerRef } = await provider.provisionEngagementWallet({
        engagementId: engagement.id,
        organizationId: engagement.organizationId,
      }));
    } catch (error) {
      console.error("Wallet provisioning failed", error);
      return closeEngagement(tx, engagement, "FAILED", null, "The wallet could not be provisioned.");
    }

    const [wallet] = await tx
      .insert(engagementWallets)
      .values({
        engagementId: engagement.id,
        organizationId: engagement.organizationId,
        rail: engagement.rail,
        asset: provider.asset.code,
        assetDecimals: provider.asset.decimals,
        provider: provider.name,
        providerRef,
        status: "awaiting_funding",
        isSimulated: provider.simulated,
      })
      .returning();

    const provisioned = await transition(
      tx,
      engagement,
      "WALLET_PROVISIONED",
      who.userId,
      provider.simulated ? "Dedicated simulated wallet provisioned." : "Dedicated wallet provisioned.",
    );
    const awaiting = await transition(
      tx,
      provisioned,
      "AWAITING_FUNDING",
      null,
      "Waiting for the buyer to authorize funding.",
    );
    await recordAudit(
      {
        actorUserId: who.userId,
        organizationId: engagement.organizationId,
        action: "engagement_wallet.provisioned",
        entityType: "engagement_wallet",
        entityId: wallet.id,
        metadata: { engagementId: engagement.id, rail: wallet.rail, simulated: wallet.isSimulated },
      },
      tx,
    );
    return awaiting;
  });
}

export type FundingOutcome = {
  funding: FundingAuthorization;
  engagement: Engagement;
  /** True when this call found an earlier authorization with the same key and did nothing. */
  replayed: boolean;
};

/**
 * A person authorizes moving a specific amount from the organization's master
 * account into this engagement's wallet. It is always its own decision:
 * authorizing a mandate or raising a budget never funds a wallet.
 *
 * The first funding of a waiting engagement also activates it, once the
 * mandate, seller, agent and wallet have all been re-checked.
 */
export async function authorizeFunding(
  actor: Actor | null,
  engagementId: string,
  rawInput: unknown,
): Promise<FundingOutcome> {
  const input = parseInput(fundingInput, rawInput);

  return withEngagement(actor, engagementId, "engagement.fund", async (tx, engagement, who) => {
    // A repeated submit of the same authorization must not fund twice.
    const [earlier] = await tx
      .select()
      .from(fundingAuthorizations)
      .where(eq(fundingAuthorizations.idempotencyKey, input.idempotencyKey));
    if (earlier) {
      if (earlier.engagementId !== engagement.id) {
        throw conflict("Reload the page and try again.");
      }
      return { funding: earlier, engagement, replayed: true };
    }

    if (!permitsFunding(engagement.state) || !engagement.rail || !engagement.sellerProfileId) {
      throw conflict(
        `Funding cannot be authorized while the engagement is ${ENGAGEMENT_STATE_LABELS[engagement.state].toLowerCase()}.`,
      );
    }
    const [wallet] = await tx
      .select()
      .from(engagementWallets)
      .where(eq(engagementWallets.engagementId, engagement.id))
      .for("update");
    if (!wallet || (wallet.status !== "awaiting_funding" && wallet.status !== "active")) {
      throw conflict("This engagement's wallet cannot receive funds.");
    }
    // Funds only ever come from this organization's master account on the same rail.
    const master = await ensureMasterAccount(tx, engagement.organizationId, engagement.rail);
    if (master.rail !== wallet.rail || master.asset !== wallet.asset) {
      throw conflict("The master account and the wallet are not on the same rail.");
    }

    const asset: AssetInfo = { code: wallet.asset, decimals: wallet.assetDecimals };
    const amount = parseUnits(input.amount, asset.decimals);
    if (amount === null || amount <= 0n) {
      throw invalid("Check the highlighted fields.", {
        amount: ["Enter an amount greater than zero, such as 100 or 100.00."],
      });
    }
    if (amount > master.balanceUnits) {
      throw invalid("Check the highlighted fields.", {
        amount: [
          `Only ${formatUnits(master.balanceUnits, asset)} is available in the ${engagement.rail} master account.`,
        ],
      });
    }

    const [mandate] = await tx
      .select()
      .from(spendingMandates)
      .where(eq(spendingMandates.engagementId, engagement.id));
    const [seller] = await tx
      .select({ status: sellerProfiles.status })
      .from(sellerProfiles)
      .where(eq(sellerProfiles.id, engagement.sellerProfileId));
    const [agent] = await tx
      .select()
      .from(purchasingAgents)
      .where(eq(purchasingAgents.engagementId, engagement.id));
    if (!mandate || mandate.status !== "authorized" || !agent) {
      throw conflict("This engagement has no authorized mandate.");
    }
    if (!seller || seller.status !== "active") {
      throw conflict("This seller's listing is no longer active, so the engagement cannot be funded.");
    }

    const provider = getWalletProvider(engagement.rail);
    const [funding] = await tx
      .insert(fundingAuthorizations)
      .values({
        engagementId: engagement.id,
        engagementWalletId: wallet.id,
        masterWalletAccountId: master.id,
        rail: engagement.rail,
        asset: asset.code,
        amountUnits: amount,
        idempotencyKey: input.idempotencyKey,
        isSimulated: provider.simulated,
        authorizedBy: who.userId,
      })
      .returning();

    const result = await provider.executeFunding({
      fundingAuthorizationId: funding.id,
      idempotencyKey: input.idempotencyKey,
      fromProviderRef: master.providerRef,
      toProviderRef: wallet.providerRef,
      amountUnits: amount,
    });
    if (result.status === "failed") {
      const [failed] = await tx
        .update(fundingAuthorizations)
        .set({ status: "failed", failureReason: result.reason })
        .where(eq(fundingAuthorizations.id, funding.id))
        .returning();
      await recordAudit(
        {
          actorUserId: who.userId,
          organizationId: engagement.organizationId,
          action: "funding.failed",
          entityType: "funding_authorization",
          entityId: funding.id,
          metadata: { reason: result.reason, amountUnits: amount.toString() },
        },
        tx,
      );
      return { funding: failed, engagement, replayed: false };
    }

    const amountSql = sql`${amount.toString()}::numeric`;
    const [debited] = await tx
      .update(masterWalletAccounts)
      .set({ balanceUnits: sql`${masterWalletAccounts.balanceUnits} - ${amountSql}` })
      .where(eq(masterWalletAccounts.id, master.id))
      .returning();
    const [credited] = await tx
      .update(engagementWallets)
      .set({
        balanceUnits: sql`${engagementWallets.balanceUnits} + ${amountSql}`,
        status: "active",
      })
      .where(eq(engagementWallets.id, wallet.id))
      .returning();
    await tx.insert(walletLedgerEntries).values([
      {
        organizationId: engagement.organizationId,
        rail: engagement.rail,
        masterWalletAccountId: master.id,
        kind: "funding_debit",
        deltaUnits: -amount,
        balanceAfterUnits: debited.balanceUnits,
        fundingAuthorizationId: funding.id,
        actorUserId: who.userId,
      },
      {
        organizationId: engagement.organizationId,
        rail: engagement.rail,
        engagementWalletId: wallet.id,
        kind: "funding_credit",
        deltaUnits: amount,
        balanceAfterUnits: credited.balanceUnits,
        fundingAuthorizationId: funding.id,
        actorUserId: who.userId,
      },
    ]);
    const [executed] = await tx
      .update(fundingAuthorizations)
      .set({ status: "executed", providerRef: result.providerRef, executedAt: new Date() })
      .where(eq(fundingAuthorizations.id, funding.id))
      .returning();

    // If the agent was waiting for more funds, this authorization answers it.
    let current = await settleFundingRequest(tx, engagement, who.userId);
    if (engagement.state === "AWAITING_FUNDING") {
      await tx
        .update(purchasingAgents)
        .set({ status: "active", activatedAt: new Date() })
        .where(eq(purchasingAgents.id, agent.id));
      current = await transition(
        tx,
        engagement,
        "ACTIVE",
        who.userId,
        "Funding authorized by the buyer; mandate, seller and wallet checks passed.",
      );
    }

    await recordAudit(
      {
        actorUserId: who.userId,
        organizationId: engagement.organizationId,
        action: "funding.authorized",
        entityType: "funding_authorization",
        entityId: funding.id,
        metadata: {
          engagementId: engagement.id,
          rail: engagement.rail,
          asset: asset.code,
          amountUnits: amount.toString(),
          simulated: provider.simulated,
        },
      },
      tx,
    );
    return { funding: executed, engagement: current, replayed: false };
  });
}

/** End an engagement at the buyer's instruction. Final. */
export async function cancelEngagement(actor: Actor | null, engagementId: string): Promise<Engagement> {
  return withEngagement(actor, engagementId, "engagement.terminate", async (tx, engagement, who) => {
    if (isTerminal(engagement.state)) {
      throw conflict("This engagement has already ended.");
    }
    return closeEngagement(tx, engagement, "CANCELLED", who.userId, "Cancelled by the buyer.");
  });
}

// ---------------------------------------------------------------------------
// Reading engagements
// ---------------------------------------------------------------------------

export type EngagementSummary = {
  id: string;
  state: EngagementState;
  rail: PaymentRail | null;
  sellerName: string;
  sellerSlug: string;
  sellerIsSample: boolean;
  projectName: string;
  asset: AssetInfo | null;
  totalAuthorizedUnits: bigint | null;
  walletBalanceUnits: bigint | null;
  expiresAt: Date | null;
  createdAt: Date;
};

export async function listEngagements(
  actor: Actor | null,
  organizationId: string,
): Promise<EngagementSummary[]> {
  await requirePermission(actor, organizationId, "engagement.view");
  await settleExpired(organizationId);

  const rows = await getDb()
    .select({
      engagement: engagements,
      sellerName: sellerProfiles.displayName,
      sellerSlug: sellerProfiles.slug,
      sellerIsSample: sellerProfiles.isSample,
      projectName: projects.name,
      mandateAsset: spendingMandates.asset,
      mandateDecimals: spendingMandates.assetDecimals,
      totalAuthorizedUnits: spendingMandates.totalAuthorizedUnits,
      walletBalanceUnits: engagementWallets.balanceUnits,
    })
    .from(engagements)
    .innerJoin(sellerProfiles, eq(sellerProfiles.id, engagements.sellerProfileId))
    .innerJoin(projects, eq(projects.id, engagements.projectId))
    .leftJoin(spendingMandates, eq(spendingMandates.engagementId, engagements.id))
    .leftJoin(engagementWallets, eq(engagementWallets.engagementId, engagements.id))
    .where(eq(engagements.organizationId, organizationId))
    .orderBy(desc(engagements.createdAt));

  return rows.map((row) => ({
    id: row.engagement.id,
    state: row.engagement.state,
    rail: row.engagement.rail,
    sellerName: row.sellerName,
    sellerSlug: row.sellerSlug,
    sellerIsSample: row.sellerIsSample,
    projectName: row.projectName,
    asset:
      row.mandateAsset !== null && row.mandateDecimals !== null
        ? { code: row.mandateAsset, decimals: row.mandateDecimals }
        : null,
    totalAuthorizedUnits: row.totalAuthorizedUnits,
    walletBalanceUnits: row.walletBalanceUnits,
    expiresAt: row.engagement.expiresAt,
    createdAt: row.engagement.createdAt,
  }));
}

export type EngagementDetail = {
  engagement: Engagement;
  role: OrgRole;
  can: { draft: boolean; authorize: boolean; fund: boolean; terminate: boolean };
  seller: {
    id: string;
    slug: string;
    displayName: string;
    tagline: string;
    isSample: boolean;
    isActive: boolean;
    intendedRails: string[];
    offerings: Array<{
      id: string;
      name: string;
      description: string;
      capability: string;
      billingUnit: BillingUnit;
      priceMinor: number;
      currency: string;
      isActive: boolean;
    }>;
  };
  project: { id: string; name: string; hasWeb3: boolean };
  mandate: {
    status: MandateStatus;
    asset: AssetInfo;
    totalAuthorizedUnits: bigint;
    perTransactionLimitUnits: bigint;
    scope: string;
    expiresAt: Date;
    /** Whole days until the deadline, at least 1. Used to prefill the draft form. */
    daysUntilExpiry: number;
    authorizedAt: Date | null;
    authorizedRecipient: string | null;
    permittedOfferingIds: string[];
  } | null;
  wallet: {
    id: string;
    status: WalletStatus;
    asset: AssetInfo;
    balanceUnits: bigint;
    providerRef: string;
    isSimulated: boolean;
  } | null;
  /** The organization's master account on this engagement's rail, if set up. */
  masterBalanceUnits: bigint | null;
  agent: { status: AgentStatus } | null;
  fundings: Array<{
    id: string;
    amountUnits: bigint;
    status: FundingAuthorization["status"];
    isSimulated: boolean;
    authorizedAt: Date;
    failureReason: string | null;
  }>;
  events: Array<{
    id: string;
    fromState: EngagementState | null;
    toState: EngagementState;
    note: string;
    actorName: string | null;
    createdAt: Date;
  }>;
};

export async function getEngagementDetail(
  actor: Actor | null,
  engagementId: string,
): Promise<EngagementDetail> {
  assertAuthenticated(actor);
  if (!isUuid(engagementId)) throw notFound("Engagement");
  const db = getDb();

  const [found] = await db.select().from(engagements).where(eq(engagements.id, engagementId));
  const membership = await requirePermissionOnRecord(actor, found, "engagement.view", "Engagement");
  await settleExpired(found.organizationId);
  const [engagement] = await db.select().from(engagements).where(eq(engagements.id, engagementId));
  if (!engagement.sellerProfileId) throw notFound("Engagement");

  const [seller] = await db
    .select()
    .from(sellerProfiles)
    .where(eq(sellerProfiles.id, engagement.sellerProfileId));
  const offerings = await db
    .select()
    .from(serviceOfferings)
    .where(eq(serviceOfferings.sellerProfileId, seller.id))
    .orderBy(asc(serviceOfferings.priceMinor), asc(serviceOfferings.name));
  const [project] = await db.select().from(projects).where(eq(projects.id, engagement.projectId));

  const [mandate] = await db
    .select()
    .from(spendingMandates)
    .where(eq(spendingMandates.engagementId, engagement.id));
  const permitted = mandate
    ? await db
        .select({ id: mandatePermittedOfferings.serviceOfferingId })
        .from(mandatePermittedOfferings)
        .where(eq(mandatePermittedOfferings.mandateId, mandate.id))
    : [];

  const [wallet] = await db
    .select()
    .from(engagementWallets)
    .where(eq(engagementWallets.engagementId, engagement.id));
  const [master] = engagement.rail
    ? await db
        .select({ balanceUnits: masterWalletAccounts.balanceUnits })
        .from(masterWalletAccounts)
        .where(
          and(
            eq(masterWalletAccounts.organizationId, engagement.organizationId),
            eq(masterWalletAccounts.rail, engagement.rail),
          ),
        )
    : [];
  const [agent] = await db
    .select({ status: purchasingAgents.status })
    .from(purchasingAgents)
    .where(eq(purchasingAgents.engagementId, engagement.id));
  const fundings = await db
    .select()
    .from(fundingAuthorizations)
    .where(eq(fundingAuthorizations.engagementId, engagement.id))
    .orderBy(desc(fundingAuthorizations.createdAt));
  const events = await db
    .select({ event: engagementEvents, actorName: users.displayName })
    .from(engagementEvents)
    .leftJoin(users, eq(users.id, engagementEvents.actorUserId))
    .where(eq(engagementEvents.engagementId, engagement.id))
    .orderBy(asc(engagementEvents.sequence));

  const role = membership.role;
  return {
    engagement,
    role,
    can: {
      draft: roleHasPermission(role, "engagement.draft"),
      authorize: roleHasPermission(role, "engagement.authorize"),
      fund: roleHasPermission(role, "engagement.fund"),
      terminate: roleHasPermission(role, "engagement.terminate"),
    },
    seller: {
      id: seller.id,
      slug: seller.slug,
      displayName: seller.displayName,
      tagline: seller.tagline,
      isSample: seller.isSample,
      isActive: seller.status === "active",
      intendedRails: seller.intendedRails,
      offerings: offerings.map((o) => ({
        id: o.id,
        name: o.name,
        description: o.description,
        capability: o.capability,
        billingUnit: o.billingUnit,
        priceMinor: o.priceMinor,
        currency: o.currency,
        isActive: o.isActive,
      })),
    },
    project: { id: project.id, name: project.name, hasWeb3: project.hasWeb3 },
    mandate: mandate
      ? {
          status: mandate.status,
          asset: { code: mandate.asset, decimals: mandate.assetDecimals },
          totalAuthorizedUnits: mandate.totalAuthorizedUnits,
          perTransactionLimitUnits: mandate.perTransactionLimitUnits,
          scope: mandate.scope,
          expiresAt: mandate.expiresAt,
          daysUntilExpiry: Math.max(
            1,
            Math.round((mandate.expiresAt.getTime() - Date.now()) / DAY_MS),
          ),
          authorizedAt: mandate.authorizedAt,
          authorizedRecipient: mandate.authorizedRecipient,
          permittedOfferingIds: permitted.map((p) => p.id),
        }
      : null,
    wallet: wallet
      ? {
          id: wallet.id,
          status: wallet.status,
          asset: { code: wallet.asset, decimals: wallet.assetDecimals },
          balanceUnits: wallet.balanceUnits,
          providerRef: wallet.providerRef,
          isSimulated: wallet.isSimulated,
        }
      : null,
    masterBalanceUnits: master?.balanceUnits ?? null,
    agent: agent ?? null,
    fundings: fundings.map((f) => ({
      id: f.id,
      amountUnits: f.amountUnits,
      status: f.status,
      isSimulated: f.isSimulated,
      authorizedAt: f.authorizedAt,
      failureReason: f.failureReason,
    })),
    events: events.map(({ event, actorName }) => ({
      id: event.id,
      fromState: event.fromState,
      toState: event.toState,
      note: event.note,
      actorName,
      createdAt: event.createdAt,
    })),
  };
}
