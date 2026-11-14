import { randomUUID } from "node:crypto";
import Link from "next/link";
import { NotYetActive, Panel } from "@/components/app/page-header";
import { SimulatedBadge } from "@/components/engagements/badges";
import { AutoRefresh } from "@/components/testing/auto-refresh";
import { JobBadge } from "@/components/testing/badges";
import { Button } from "@/components/ui/button";
import type { EngagementState, PurchaseStatus } from "@/db/schema";
import { formatUnits, unitsToDecimalString } from "@/lib/units";
import { cn } from "@/lib/utils";
import type { ApprovalSummary } from "@/server/approvals";
import type { BudgetStatus } from "@/server/budget";
import type { EngagementActivity, MessageLine, PurchaseLine } from "@/server/engagement-activity";
import {
  BudgetDecisionForms,
  DeclineFundingForm,
  ReconcileButton,
  RunAgentForm,
} from "./agent-forms";

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
const timeFormat = new Intl.DateTimeFormat("en", { timeStyle: "medium" });

function Fact({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
  return (
    <div>
      <dt className="eyebrow">{label}</dt>
      <dd
        className={cn(
          "figure mt-1 text-base whitespace-nowrap",
          tone === "warn" ? "text-warn" : "text-foreground",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/** How much of the budget is used, and what the wallet holds. Authority and money, side by side. */
export function BudgetPanel({ budget }: { budget: BudgetStatus }) {
  const used = budget.spentUnits + budget.reservedUnits;
  const percent = budget.totalUnits > 0n ? Number((used * 1000n) / budget.totalUnits) / 10 : 0;
  const remaining = budget.remainingUnits > 0n ? budget.remainingUnits : 0n;
  return (
    <Panel
      title="Budget and funds"
      description="The budget is what the agent may spend. The wallet is what it has to spend. A purchase needs both."
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <Fact label="Spent" value={formatUnits(budget.spentUnits, budget.asset)} />
        <Fact label="Reserved" value={formatUnits(budget.reservedUnits, budget.asset)} />
        <Fact label="Budget left" value={formatUnits(remaining, budget.asset)} />
        <Fact label="In wallet" value={formatUnits(budget.walletBalanceUnits, budget.asset)} />
      </dl>
      <div className="mt-6">
        <div
          className="h-2 overflow-hidden rounded-full bg-muted"
          role="img"
          aria-label={`${formatUnits(used, budget.asset)} of ${formatUnits(budget.totalUnits, budget.asset)} spent or reserved`}
        >
          <div className="h-full rounded-full bg-brand" style={{ width: `${Math.min(percent, 100)}%` }} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {formatUnits(used, budget.asset)} of {formatUnits(budget.totalUnits, budget.asset)} spent or
          reserved · up to {formatUnits(budget.perTransactionUnits, budget.asset)} per purchase
        </p>
      </div>
    </Panel>
  );
}

/** The open question for the buyer, with what the agent has done and what it proposes. */
export function ApprovalPanel({
  approval,
  activity,
}: {
  approval: ApprovalSummary;
  activity: EngagementActivity;
}) {
  const asset = approval.asset;
  const delivered = activity.purchases.filter((p) => p.status === "delivered" || p.status === "paid");
  const reported = delivered.filter((p) => p.job?.outcome);
  const needed = approval.spentUnits + approval.reservedUnits + approval.proposedAmountUnits;
  const isBudget = approval.kind === "budget_increase";

  return (
    <section className="rounded-xl border border-warn/40 bg-card" aria-labelledby="approval-heading">
      <div className="border-b border-warn/30 bg-warn-dim px-5 py-4">
        <p className="eyebrow text-warn">Your decision is needed</p>
        <h2 id="approval-heading" className="mt-1 text-lg font-semibold text-foreground">
          {isBudget
            ? `${approval.sellerName}'s agent wants to exceed the budget`
            : "The engagement wallet needs more funds"}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          The agent has stopped. Nothing more will be bought until you decide.
        </p>
      </div>

      <div className="space-y-6 p-5">
        <div>
          <p className="text-sm font-medium text-foreground">Proposed next purchase</p>
          <p className="mt-1 text-sm text-ink-soft">
            {approval.offeringName} for{" "}
            <span className="figure text-foreground">{formatUnits(approval.proposedAmountUnits, asset)}</span>
          </p>
          {approval.explanation ? (
            <p className="mt-1 text-sm text-muted-foreground">The agent&apos;s reason: {approval.explanation}</p>
          ) : null}
        </div>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
          <Fact label="Budget" value={formatUnits(approval.totalAuthorizedUnits, asset)} />
          <Fact label="Spent" value={formatUnits(approval.spentUnits, asset)} />
          <Fact label="Reserved" value={formatUnits(approval.reservedUnits, asset)} />
          {isBudget ? (
            <Fact label="Extra budget needed" value={formatUnits(approval.shortfallUnits, asset)} tone="warn" />
          ) : (
            <Fact label="Extra funds needed" value={formatUnits(approval.shortfallUnits, asset)} tone="warn" />
          )}
        </dl>

        <div>
          <p className="text-sm font-medium text-foreground">Work completed so far</p>
          {delivered.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">Nothing has been purchased yet.</p>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                {delivered.length} {delivered.length === 1 ? "purchase" : "purchases"} paid for.
                {" "}
                {reported.length === 0
                  ? "No test has reported a result yet."
                  : `${reported.length} ${reported.length === 1 ? "has" : "have"} reported a result; open a purchase below to read it.`}
              </p>
              <ul className="mt-2 space-y-1 text-sm text-ink-soft">
                {delivered.slice(0, 8).map((purchase) => (
                  <li key={purchase.id} className="flex justify-between gap-4">
                    <span>
                      {purchase.offeringName}
                      {purchase.job?.summary ? (
                        <span className="block text-xs text-muted-foreground">{purchase.job.summary}</span>
                      ) : null}
                    </span>
                    <span className="figure text-muted-foreground">
                      {formatUnits(purchase.amountUnits, purchase.asset)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="border-t border-border pt-5">
          {!activity.can.approve ? (
            <p className="text-sm text-muted-foreground">
              Only the organization&apos;s owner can decide this request.
            </p>
          ) : isBudget ? (
            <BudgetDecisionForms
              approvalId={approval.id}
              assetCode={asset.code}
              minimumTotal={unitsToDecimalString(needed, asset.decimals)}
              currentTotalLabel={formatUnits(approval.totalAuthorizedUnits, asset)}
              alternatives={activity.alternatives.map((option) => ({
                id: option.id,
                label: `${option.name} · ${formatUnits(option.priceUnits, asset)}`,
              }))}
            />
          ) : (
            <div className="space-y-4">
              <p className="max-w-xl text-sm leading-relaxed text-ink-soft">
                The budget allows this purchase, but the wallet holds{" "}
                <span className="figure text-foreground">{formatUnits(approval.walletBalanceUnits, asset)}</span>.
                To continue, authorize funding of at least{" "}
                <span className="figure text-foreground">{formatUnits(approval.shortfallUnits, asset)}</span>{" "}
                in the funding section below. That is a separate authorization; the agent resumes
                once the wallet can cover the purchase.
              </p>
              <DeclineFundingForm approvalId={approval.id} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Where the buyer starts the agent, and what its last run did. */
export function AgentPanel({
  engagementId,
  state,
  sellerName,
  activity,
}: {
  engagementId: string;
  state: EngagementState;
  sellerName: string;
  activity: EngagementActivity;
}) {
  const { lastRun, sellerConnection, testing } = activity;
  const runnable = testing?.services.filter((service) => service.blocker === null) ?? [];
  const blocked = testing?.services.filter((service) => service.blocker !== null) ?? [];
  return (
    <Panel
      title="Purchasing agent"
      description={`Buys permitted services from ${sellerName}, one purchase at a time, inside the mandate.`}
      action={sellerConnection?.simulated ? <SimulatedBadge /> : null}
    >
      <div className="space-y-5">
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Seller connection</dt>
            <dd className="mt-0.5 text-foreground">
              {sellerConnection ? sellerConnection.description : "Not connected"}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Agent</dt>
            <dd className="mt-0.5 text-foreground">Scripted demo agent, no language model</dd>
          </div>
          {testing ? (
            <div className="sm:col-span-2">
              <dt className="text-muted-foreground">Test execution</dt>
              <dd className="mt-0.5 text-foreground">
                {runnable.length > 0 ? (
                  <>
                    <span className="text-brand">Testing worker online.</span> It can run{" "}
                    {runnable.map((service) => service.name).join(", ")}.
                  </>
                ) : (
                  <span className="text-warn">None of the permitted tests can be run right now.</span>
                )}
                {blocked.length > 0 ? (
                  <span className="mt-1 block text-sm text-muted-foreground">
                    The seller will decline {blocked.map((service) => service.name).join(", ")} before
                    any payment: {blocked[0].blocker}
                  </span>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>

        {!sellerConnection ? (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {sellerName}&apos;s agent endpoint is not connected yet. In this version the purchasing
            agent can only run against the sample sellers. <NotYetActive />
          </p>
        ) : state === "ACTIVE" ? (
          activity.can.operate ? (
            <>
              <p className="max-w-xl text-sm leading-relaxed text-ink-soft">
                Each run makes up to six purchases, then stops. The agent cannot change the budget,
                the seller, the services or the wallet; if a purchase would exceed the budget it
                stops and asks you.
              </p>
              {/* A new key per page render, so a repeated click starts one run. */}
              <RunAgentForm
                key={lastRun?.id ?? "first"}
                engagementId={engagementId}
                runKey={randomUUID()}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Owners and admins can run the agent.</p>
          )
        ) : state === "PAUSED_FOR_APPROVAL" ? (
          <p className="text-sm text-warn">The agent is paused until you decide the request above.</p>
        ) : (
          <p className="text-sm text-muted-foreground">The agent can only run while the engagement is active.</p>
        )}

        {lastRun ? (
          <div className="rounded-lg border border-border bg-background/40 p-4">
            <p className="eyebrow">Last run · {dateTimeFormat.format(lastRun.startedAt)}</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              {lastRun.summary || "The run is in progress."}
            </p>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

const PURCHASE_LABELS: Record<PurchaseStatus, { label: string; className: string }> = {
  delivered: { label: "Paid · test completed", className: "text-brand" },
  paid: { label: "Paid", className: "text-brand" },
  reserved: { label: "Payment in progress", className: "text-ink-soft" },
  blocked: { label: "Blocked", className: "text-warn" },
  payment_failed: { label: "Payment failed · nothing charged", className: "text-destructive" },
  needs_reconciliation: { label: "Outcome unknown · not retried", className: "text-warn" },
};

function PurchaseRow({ purchase, canOperate }: { purchase: PurchaseLine; canOperate: boolean }) {
  const status = PURCHASE_LABELS[purchase.status];
  return (
    <li className="space-y-1.5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-medium text-foreground">
          {purchase.offeringName}
          {purchase.quantity > 1 ? ` × ${purchase.quantity}` : ""}
        </p>
        <p className="figure text-foreground">{formatUnits(purchase.amountUnits, purchase.asset)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className={status.className}>{status.label}</span>
        <span className="text-muted-foreground">{dateTimeFormat.format(purchase.createdAt)}</span>
        {purchase.isSimulated && (purchase.status === "paid" || purchase.status === "delivered") ? (
          <SimulatedBadge label="Payment simulated" />
        ) : null}
      </div>
      {purchase.message ? <p className="text-sm text-muted-foreground">{purchase.message}</p> : null}
      {purchase.job ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-0.5">
          <JobBadge status={purchase.job.status} outcome={purchase.job.outcome} />
          <span className="text-sm text-ink-soft">
            {purchase.job.summary ??
              (purchase.job.status === "running"
                ? "A testing worker is executing this now."
                : "Waiting for a testing worker.")}
          </span>
          <Link
            href={`/reports/${purchase.job.id}`}
            className="text-sm text-foreground underline underline-offset-4 hover:text-brand"
          >
            {purchase.job.outcome ? "View report" : "View job"}
          </Link>
        </div>
      ) : purchase.deliverySummary ? (
        <p className="text-sm text-muted-foreground">{purchase.deliverySummary}</p>
      ) : null}
      {purchase.paymentReference ? (
        <p className="figure text-xs break-all text-muted-foreground">{purchase.paymentReference}</p>
      ) : null}
      {purchase.status === "needs_reconciliation" && canOperate ? (
        <div className="pt-1">
          <ReconcileButton purchaseId={purchase.id} />
        </div>
      ) : null}
    </li>
  );
}

export function PurchasesPanel({ activity }: { activity: EngagementActivity }) {
  return (
    <Panel
      title="Purchases"
      description="Everything the agent has tried to buy, including what was blocked."
      action={
        activity.purchases.length > 0 ? (
          <Button asChild variant="ghost" size="lg" className="h-9 px-3">
            <Link href="/transactions">All transactions</Link>
          </Button>
        ) : null
      }
    >
      {activity.purchases.some((p) => p.job?.status === "queued" || p.job?.status === "running") ? (
        <AutoRefresh />
      ) : null}
      {activity.purchases.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing yet. Purchases appear here once the agent runs.</p>
      ) : (
        <ul className="-my-4 divide-y divide-border">
          {activity.purchases.map((purchase) => (
            <PurchaseRow key={purchase.id} purchase={purchase} canOperate={activity.can.operate} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

const MESSAGE_KINDS: Record<string, string> = {
  quote_request: "asked for a quote",
  quote: "quoted",
  delivery_request: "asked for the test to be run",
  accepted: "accepted the work and queued the test",
  delivery: "delivered",
  test_completed: "Test completed",
  test_not_run: "Test could not be run",
  refusal: "refused",
  payment_confirmed: "Payment confirmed",
  payment_failed: "Payment failed",
  payment_uncertain: "Payment outcome unknown",
  purchase_blocked: "Purchase blocked",
  tool_refused: "Agent action refused",
};

function describe(message: MessageLine, sellerName: string): { who: string; what: string } {
  const body = message.body;
  const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : "");
  const kind = MESSAGE_KINDS[message.kind] ?? message.kind;
  if (message.direction === "agent_to_seller") return { who: "Agent", what: `${kind}` };
  if (message.direction === "seller_to_agent") {
    const detail = message.kind === "refusal" ? text("reason") : "";
    return { who: sellerName, what: detail ? `${kind}: ${detail}` : kind };
  }
  const detail = text("message") || text("reason") || [text("service"), text("amount")].filter(Boolean).join(" · ");
  return { who: "905 Finance", what: detail ? `${kind}. ${detail}` : kind };
}

/** The exchange between the agent and the seller, with the platform's own notes. */
export function ConversationPanel({
  messages,
  sellerName,
}: {
  messages: MessageLine[];
  sellerName: string;
}) {
  if (messages.length === 0) return null;
  return (
    <Panel
      title="Agent and seller messages"
      description="Recorded by the platform. Messages are only possible while the engagement is active."
    >
      <details>
        <summary className="cursor-pointer text-sm text-ink-soft outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          Show the last {messages.length} messages
        </summary>
        <ol className="mt-4 space-y-2.5">
          {messages.map((message) => {
            const { who, what } = describe(message, sellerName);
            return (
              <li key={message.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 text-sm">
                <span className="figure text-xs text-muted-foreground">{timeFormat.format(message.createdAt)}</span>
                <span className="min-w-0 break-words text-ink-soft">
                  <span
                    className={cn(
                      "font-medium",
                      message.direction === "platform" ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {who}
                  </span>{" "}
                  {what}
                </span>
              </li>
            );
          })}
        </ol>
      </details>
    </Panel>
  );
}
