import "server-only";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db/client";
import type { AgentRun, ServiceOffering } from "@/db/schema";
import { ENGAGEMENT_STATE_LABELS } from "@/lib/engagement-state";
import type { AssetInfo } from "@/lib/units";
import { assertAgentMayContactSeller } from "../agent-gate";
import { assertAuthenticated, type Actor } from "../authz";
import { getBudgetStatus, offeringPriceUnits } from "../budget";
import { withEngagement } from "../engagement-core";
import { conflict, invalid, isAppError } from "../errors";
import { executePurchase, recordDelivery } from "../policy";
import { getWalletProvider } from "../wallets/registry";
import { ScriptedBrain, type AgentBrain, type AgentContext, type AgentToolCall } from "./brain";
import {
  resolveSellerTransport,
  type AgentToSeller,
  type SellerReply,
  type SellerTransport,
} from "./transport";

const {
  agentRuns,
  agentMessages,
  engagements,
  spendingMandates,
  mandatePermittedOfferings,
  serviceOfferings,
  sellerProfiles,
  purchases,
  approvalRequests,
} = schema;

/**
 * The purchasing-agent runtime.
 *
 * A person starts a run. The runtime then asks the brain for one step at a
 * time and carries out only steps that are valid calls to tools it offers.
 * Every message to the seller passes the communication gate, and every
 * purchase goes through the policy engine. The runtime never trusts what the
 * brain proposes or what the seller replies.
 */

const DEFAULT_MAX_PURCHASES = 6;
const MAX_REFUSED_STEPS = 3;
const STALE_RUN_MS = 2 * 60 * 1000;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** The complete set of tools. Unknown tools and unexpected fields are refused. */
const toolCall = z.discriminatedUnion("tool", [
  z.object({
    tool: z.literal("purchase_service"),
    input: z
      .object({
        offeringId: uuid,
        quantity: z.number().int().min(1).max(100).optional(),
        reason: z.string().max(500).default(""),
      })
      .strict(),
  }),
  z.object({
    tool: z.literal("finish"),
    input: z.object({ summary: z.string().max(500).default("") }).strict(),
  }),
]);

/** What a seller may send back. Anything else is treated as a refusal. */
const sellerReply = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("quote"),
    offeringId: z.string().max(100),
    quantity: z.number().int().min(1).max(100),
    asset: z.string().max(40),
    amountUnits: z.string().regex(/^\d{1,60}$/),
    recipient: z.string().max(500),
    note: z.string().max(2000).optional(),
  }),
  z.object({
    kind: z.literal("delivery"),
    purchaseId: z.string().max(100),
    result: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal("refusal"), reason: z.string().max(500) }),
]);

export type AgentRunResult = { run: AgentRun; replayed: boolean };

type RunSetup = {
  run: AgentRun;
  replayed: boolean;
  sellerProfileId: string;
  sellerName: string;
  scope: string;
  asset: AssetInfo;
  transport: SellerTransport | null;
};

async function platformNote(
  engagementId: string,
  runId: string,
  kind: string,
  body: Record<string, unknown>,
) {
  await getDb().insert(agentMessages).values({
    engagementId,
    agentRunId: runId,
    direction: "platform",
    kind,
    body,
  });
}

/**
 * Send one message to the engagement's seller and return its reply. The gate
 * is checked before anything is sent, and both sides are recorded.
 */
async function exchange(
  setup: RunSetup & { transport: SellerTransport },
  engagementId: string,
  message: AgentToSeller,
): Promise<SellerReply> {
  await assertAgentMayContactSeller(engagementId, setup.sellerProfileId);
  await getDb().insert(agentMessages).values({
    engagementId,
    agentRunId: setup.run.id,
    sellerProfileId: setup.sellerProfileId,
    direction: "agent_to_seller",
    kind: message.kind,
    body: message,
  });

  let reply: SellerReply;
  try {
    const parsed = sellerReply.safeParse(await setup.transport.send(message));
    reply = parsed.success
      ? (parsed.data as SellerReply)
      : { kind: "refusal", reason: "The seller's reply could not be understood." };
  } catch {
    reply = { kind: "refusal", reason: "The seller did not answer." };
  }

  await getDb().insert(agentMessages).values({
    engagementId,
    agentRunId: setup.run.id,
    sellerProfileId: setup.sellerProfileId,
    direction: "seller_to_agent",
    kind: reply.kind,
    body: reply,
  });
  return reply;
}

/** What the brain is shown. Built fresh from platform records before every step. */
async function buildContext(
  engagementId: string,
  setup: RunSetup,
  purchasesThisRun: number,
  lastSellerNote: string | null,
): Promise<{ context: AgentContext; offerings: ServiceOffering[]; directiveApprovalId: string | null } | null> {
  const db = getDb();
  const budget = await getBudgetStatus(db, engagementId);
  if (!budget) return null;

  const offerings = (
    await db
      .select({ offering: serviceOfferings })
      .from(mandatePermittedOfferings)
      .innerJoin(serviceOfferings, eq(serviceOfferings.id, mandatePermittedOfferings.serviceOfferingId))
      .where(
        and(eq(mandatePermittedOfferings.mandateId, budget.mandateId), eq(serviceOfferings.isActive, true)),
      )
      .orderBy(asc(serviceOfferings.name))
  ).map((row) => row.offering);

  const bought = await db
    .select({ offeringId: purchases.serviceOfferingId })
    .from(purchases)
    .where(and(eq(purchases.engagementId, engagementId), inArray(purchases.status, ["paid", "delivered"])));

  const decided = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.engagementId, engagementId),
        inArray(approvalRequests.status, ["approved", "rejected", "modified"]),
      ),
    )
    .orderBy(desc(approvalRequests.sequence));
  const latest = decided[0];
  const directive = decided.find(
    (a) => a.status === "modified" && a.replacementOfferingId && a.replacementUsedAt === null,
  );

  const services = offerings.flatMap((offering) => {
    const price = offeringPriceUnits(offering, budget.asset);
    return price === null
      ? []
      : [
          {
            id: offering.id,
            name: offering.name,
            priceUnits: price.toString(),
            timesPurchased: bought.filter((b) => b.offeringId === offering.id).length,
          },
        ];
  });
  const clamp = (value: bigint) => (value > 0n ? value : 0n).toString();

  return {
    offerings,
    directiveApprovalId: directive?.id ?? null,
    context: {
      sellerName: setup.sellerName,
      scope: setup.scope,
      asset: budget.asset,
      services,
      budget: {
        totalUnits: budget.totalUnits.toString(),
        perTransactionUnits: budget.perTransactionUnits.toString(),
        remainingUnits: clamp(budget.remainingUnits),
        walletAvailableUnits: clamp(budget.walletAvailableUnits),
      },
      directive: directive?.replacementOfferingId ? { offeringId: directive.replacementOfferingId } : null,
      limitsAreFinal: latest !== undefined && latest.status !== "approved",
      purchasesThisRun,
      lastSellerNote,
    },
  };
}

/** Check the caller may run the agent, and open (or find) the run. */
async function startRun(
  actor: Actor,
  engagementId: string,
  runKey: string,
  brain: AgentBrain,
): Promise<RunSetup> {
  return withEngagement(actor, engagementId, "engagement.operate", async (tx, engagement, who) => {
    const [seller] = engagement.sellerProfileId
      ? await tx.select().from(sellerProfiles).where(eq(sellerProfiles.id, engagement.sellerProfileId))
      : [];
    const [mandate] = await tx
      .select()
      .from(spendingMandates)
      .where(eq(spendingMandates.engagementId, engagement.id));

    const [earlier] = await tx.select().from(agentRuns).where(eq(agentRuns.runKey, runKey));
    if (earlier) {
      if (earlier.engagementId !== engagement.id) throw conflict("Reload the page and try again.");
      return {
        run: earlier,
        replayed: true,
        sellerProfileId: seller?.id ?? "",
        sellerName: seller?.displayName ?? "",
        scope: mandate?.scope ?? "",
        asset: { code: mandate?.asset ?? "", decimals: mandate?.assetDecimals ?? 0 },
        transport: null,
      };
    }

    if (engagement.state !== "ACTIVE" || !engagement.rail || !seller || !mandate) {
      throw conflict(
        engagement.state === "PAUSED_FOR_APPROVAL"
          ? "The agent is waiting for your decision on an approval request."
          : `The agent can only run while the engagement is active. It is ${ENGAGEMENT_STATE_LABELS[engagement.state].toLowerCase()}.`,
      );
    }

    const offerings = await tx
      .select()
      .from(serviceOfferings)
      .where(eq(serviceOfferings.sellerProfileId, seller.id));
    const asset = { code: mandate.asset, decimals: mandate.assetDecimals };
    const transport = resolveSellerTransport({ seller, offerings, rail: engagement.rail, asset });
    if (!transport) {
      throw conflict(
        `${seller.displayName}'s agent is not connected yet. In this version the purchasing agent can only run against the sample sellers.`,
      );
    }
    if (getWalletProvider(engagement.rail).asset.code !== asset.code) {
      throw conflict("The engagement's asset does not match its rail.");
    }

    // A run that never finished (a crashed request) must not block the engagement for good.
    await tx
      .update(agentRuns)
      .set({ status: "failed", summary: "The run did not finish.", finishedAt: new Date() })
      .where(
        and(
          eq(agentRuns.engagementId, engagement.id),
          eq(agentRuns.status, "running"),
          lt(agentRuns.startedAt, new Date(Date.now() - STALE_RUN_MS)),
        ),
      );
    const [running] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.engagementId, engagement.id), eq(agentRuns.status, "running")));
    if (running) throw conflict("The agent is already running for this engagement.");

    const [run] = await tx
      .insert(agentRuns)
      .values({ engagementId: engagement.id, runKey, brain: brain.name, startedBy: who.userId })
      .returning();
    return {
      run,
      replayed: false,
      sellerProfileId: seller.id,
      sellerName: seller.displayName,
      scope: mandate.scope,
      asset,
      transport,
    };
  });
}

/**
 * Run an engagement's purchasing agent until it finishes, is blocked, needs a
 * person's decision, or reaches the per-run purchase cap.
 */
export async function runAgent(
  actor: Actor | null,
  engagementId: string,
  input: { runKey: string; maxPurchases?: number },
  brain: AgentBrain = new ScriptedBrain(),
): Promise<AgentRunResult> {
  assertAuthenticated(actor);
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(input.runKey)) {
    throw invalid("Reload the page and try again.");
  }
  const maxPurchases = Math.min(Math.max(input.maxPurchases ?? DEFAULT_MAX_PURCHASES, 1), 20);

  const setup = await startRun(actor, engagementId, input.runKey, brain);
  if (setup.replayed || !setup.transport) return { run: setup.run, replayed: true };
  const live = { ...setup, transport: setup.transport };

  let completed = 0;
  let refused = 0;
  let lastSellerNote: string | null = null;
  let status: AgentRun["status"] = "completed";
  let summary = "";

  try {
    for (let step = 0; step < maxPurchases * 2 + MAX_REFUSED_STEPS; step += 1) {
      const [engagement] = await getDb().select().from(engagements).where(eq(engagements.id, engagementId));
      if (engagement.state !== "ACTIVE") {
        status = engagement.state === "PAUSED_FOR_APPROVAL" ? "paused" : "completed";
        summary = `Stopped: the engagement is ${ENGAGEMENT_STATE_LABELS[engagement.state].toLowerCase()}.`;
        break;
      }
      const built = await buildContext(engagementId, setup, completed, lastSellerNote);
      if (!built) {
        summary = "Stopped: the engagement has no mandate.";
        break;
      }

      // Whatever the brain returns is only a proposal. It is validated against
      // the tools that exist before anything is done with it.
      let proposal: unknown;
      try {
        proposal = await brain.next(built.context);
      } catch {
        proposal = null;
      }
      const parsed = toolCall.safeParse(proposal);
      if (!parsed.success) {
        refused += 1;
        const attempted =
          typeof proposal === "object" && proposal !== null && "tool" in proposal
            ? String((proposal as { tool: unknown }).tool).slice(0, 80)
            : "unknown";
        await platformNote(engagementId, setup.run.id, "tool_refused", {
          attempted,
          message: "The agent proposed an action it has no tool for. Nothing was done.",
        });
        if (refused >= MAX_REFUSED_STEPS) {
          status = "failed";
          summary = "Stopped: the agent kept proposing actions it is not allowed to take.";
          break;
        }
        continue;
      }
      const call: AgentToolCall = parsed.data;

      if (call.tool === "finish") {
        summary = call.input.summary || "The agent has nothing further to do.";
        break;
      }

      const quantity = call.input.quantity ?? 1;
      const reply = await exchange(live, engagementId, {
        kind: "quote_request",
        offeringId: call.input.offeringId,
        quantity,
      });
      if (reply.kind !== "quote") {
        refused += 1;
        if (refused >= MAX_REFUSED_STEPS) {
          status = "failed";
          summary = "Stopped: the seller would not quote for what the agent asked.";
          break;
        }
        continue;
      }
      lastSellerNote = reply.note ?? null;

      if (built.directiveApprovalId && built.context.directive?.offeringId === call.input.offeringId) {
        await getDb()
          .update(approvalRequests)
          .set({ replacementUsedAt: new Date() })
          .where(and(eq(approvalRequests.id, built.directiveApprovalId), isNull(approvalRequests.replacementUsedAt)));
      }

      const outcome = await executePurchase({
        engagementId,
        offeringId: call.input.offeringId,
        quantity,
        idempotencyKey: `${setup.run.id}:${step}`,
        quote: {
          sellerProfileId: setup.sellerProfileId,
          asset: reply.asset,
          amountUnits: BigInt(reply.amountUnits),
          recipient: reply.recipient,
        },
        agentRunId: setup.run.id,
        explanation: call.input.reason,
      });

      if (outcome.status === "paid") {
        const delivery = await exchange(live, engagementId, {
          kind: "delivery_request",
          purchaseId: outcome.purchase.id,
          offeringId: outcome.purchase.serviceOfferingId,
          paymentReference: outcome.purchase.idempotencyKey,
        });
        if (delivery.kind === "delivery") {
          await recordDelivery(outcome.purchase.id, delivery.result);
        }
        completed += 1;
        if (completed >= maxPurchases) {
          summary = `Completed ${completed} purchases, the most allowed in one run.`;
          break;
        }
        continue;
      }

      if (outcome.status === "blocked") {
        status = outcome.approvalRequested ? "paused" : "completed";
        summary = outcome.approvalRequested
          ? `Paused for your decision. ${outcome.message}`
          : `Stopped. ${outcome.message}`;
        break;
      }

      status = outcome.status === "needs_reconciliation" ? "paused" : "failed";
      summary =
        outcome.status === "needs_reconciliation"
          ? "Stopped: a payment's outcome is unknown. It has not been retried and needs reconciling."
          : `Stopped: a payment failed and was not retried. ${outcome.message}`;
      break;
    }
  } catch (error) {
    status = "failed";
    summary = isAppError(error) ? `Stopped. ${error.message}` : "Stopped: the run hit an unexpected problem.";
    if (!isAppError(error)) console.error("Agent run failed", error);
  }

  if (!summary) summary = completed > 0 ? `Completed ${completed} purchases.` : "The agent did nothing.";
  else if (completed > 0 && !summary.startsWith("Completed")) {
    summary = `Completed ${completed} ${completed === 1 ? "purchase" : "purchases"}. ${summary}`;
  }

  const [finished] = await getDb()
    .update(agentRuns)
    .set({ status, summary, purchasesCompleted: completed, finishedAt: new Date() })
    .where(eq(agentRuns.id, setup.run.id))
    .returning();
  return { run: finished, replayed: false };
}
