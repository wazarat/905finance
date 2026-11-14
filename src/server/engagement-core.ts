import "server-only";
import { and, eq, inArray, lte } from "drizzle-orm";
import { getDb, schema, type Tx } from "@/db/client";
import type { Engagement, EngagementState } from "@/db/schema";
import { ENGAGEMENT_STATE_LABELS, canTransition, isSubjectToExpiry } from "@/lib/engagement-state";
import { recordAudit } from "./audit";
import {
  assertAuthenticated,
  isUuid,
  requirePermissionOnRecord,
  type Actor,
  type Permission,
} from "./authz";
import { conflict, notFound } from "./errors";
import { getWalletProvider } from "./wallets/registry";

const {
  engagements,
  engagementEvents,
  spendingMandates,
  purchasingAgents,
  engagementWallets,
  approvalRequests,
} = schema;

/**
 * The shared mechanics every engagement change relies on: the one function
 * that writes state, the one that ends an engagement, deadline handling, and
 * the wrapper that locks an engagement and checks the caller's permission.
 */

// ---------------------------------------------------------------------------
// State changes
// ---------------------------------------------------------------------------

/**
 * The only place an engagement's state is written. It refuses any change the
 * state machine does not allow, updates the row only if it is still in the
 * state the caller saw, and records the change in the engagement's history.
 */
export async function transition(
  tx: Tx,
  engagement: Engagement,
  to: EngagementState,
  actorUserId: string | null,
  note: string,
  extra: Partial<typeof engagements.$inferInsert> = {},
): Promise<Engagement> {
  if (!canTransition(engagement.state, to)) {
    throw conflict(
      `An engagement that is ${ENGAGEMENT_STATE_LABELS[engagement.state].toLowerCase()} cannot become ${ENGAGEMENT_STATE_LABELS[to].toLowerCase()}.`,
    );
  }
  const [updated] = await tx
    .update(engagements)
    .set({ ...extra, state: to, stateChangedAt: new Date() })
    .where(and(eq(engagements.id, engagement.id), eq(engagements.state, engagement.state)))
    .returning();
  if (!updated) {
    throw conflict("This engagement changed while you were working. Reload and try again.");
  }
  await tx.insert(engagementEvents).values({
    engagementId: engagement.id,
    fromState: engagement.state,
    toState: to,
    actorUserId,
    note,
  });
  return updated;
}

/**
 * End an engagement. Purchasing stops immediately: the mandate and the agent
 * are revoked and the wallet can no longer be used. Any funds left in the
 * wallet stay exactly where they are until a person authorizes their return;
 * they are never moved automatically.
 */
export async function closeEngagement(
  tx: Tx,
  engagement: Engagement,
  to: "CANCELLED" | "EXPIRED" | "FAILED" | "COMPLETED",
  actorUserId: string | null,
  note: string,
): Promise<Engagement> {
  const now = new Date();
  const closed = await transition(tx, engagement, to, actorUserId, note, { closedAt: now });

  await tx
    .update(spendingMandates)
    .set({ status: "revoked" })
    .where(
      and(eq(spendingMandates.engagementId, engagement.id), eq(spendingMandates.status, "authorized")),
    );
  await tx
    .update(purchasingAgents)
    .set({ status: "revoked", revokedAt: now })
    .where(eq(purchasingAgents.engagementId, engagement.id));

  await tx
    .update(approvalRequests)
    .set({ status: "cancelled", decidedAt: now, decisionNote: "The engagement ended." })
    .where(
      and(eq(approvalRequests.engagementId, engagement.id), eq(approvalRequests.status, "pending")),
    );

  const [wallet] = await tx
    .select()
    .from(engagementWallets)
    .where(eq(engagementWallets.engagementId, engagement.id))
    .for("update");
  if (wallet) {
    await getWalletProvider(wallet.rail).suspendPurchasing({ providerRef: wallet.providerRef });
    await tx
      .update(engagementWallets)
      .set({ status: wallet.balanceUnits > 0n ? "closing" : "closed" })
      .where(eq(engagementWallets.id, wallet.id));
  }

  await recordAudit(
    {
      actorUserId,
      organizationId: engagement.organizationId,
      action: `engagement.${to.toLowerCase()}`,
      entityType: "engagement",
      entityId: engagement.id,
      metadata: { from: engagement.state, note },
    },
    tx,
  );
  return closed;
}

export function isPastDeadline(engagement: Engagement, now: Date): boolean {
  return (
    isSubjectToExpiry(engagement.state) &&
    engagement.expiresAt !== null &&
    engagement.expiresAt <= now
  );
}

type Outcome<T> = { expired: true } | { expired: false; value: T };

/**
 * Run a change against one engagement: lock it, check the caller's permission,
 * and apply the deadline first. If the engagement has just expired, that is
 * saved and the requested change is refused.
 */
export async function withEngagement<T>(
  actor: Actor | null,
  engagementId: string,
  permission: Permission,
  work: (tx: Tx, engagement: Engagement, actor: Actor) => Promise<T>,
): Promise<T> {
  assertAuthenticated(actor);
  if (!isUuid(engagementId)) throw notFound("Engagement");

  const outcome = await getDb().transaction(async (tx): Promise<Outcome<T>> => {
    const [engagement] = await tx
      .select()
      .from(engagements)
      .where(eq(engagements.id, engagementId))
      .for("update");
    await requirePermissionOnRecord(actor, engagement, permission, "Engagement", tx);

    if (isPastDeadline(engagement, new Date())) {
      await closeEngagement(tx, engagement, "EXPIRED", null, "The engagement reached its deadline.");
      return { expired: true };
    }
    return { expired: false, value: await work(tx, engagement, actor) };
  });

  if (outcome.expired) throw conflict("This engagement has expired.");
  return outcome.value;
}

/** Mark overdue engagements as expired. Called before engagements are read. */
export async function settleExpired(organizationId: string): Promise<void> {
  const db = getDb();
  const due = await db
    .select({ id: engagements.id })
    .from(engagements)
    .where(
      and(
        eq(engagements.organizationId, organizationId),
        inArray(engagements.state, [
          "AUTHORIZED",
          "WALLET_PROVISIONED",
          "AWAITING_FUNDING",
          "ACTIVE",
          "PAUSED_FOR_APPROVAL",
        ]),
        lte(engagements.expiresAt, new Date()),
      ),
    );
  for (const { id } of due) {
    await db.transaction(async (tx) => {
      const [engagement] = await tx.select().from(engagements).where(eq(engagements.id, id)).for("update");
      if (engagement && isPastDeadline(engagement, new Date())) {
        await closeEngagement(tx, engagement, "EXPIRED", null, "The engagement reached its deadline.");
      }
    });
  }
}
