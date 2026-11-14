import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { EmptyState, PageHeader, Panel } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { SimulatedBadge } from "@/components/engagements/badges";
import { railLabel } from "@/lib/capabilities";
import { formatUnits } from "@/lib/units";
import { requireWorkspace } from "@/server/page-context";
import { getSpendingTotals, listPayments, type PaymentLine } from "@/server/transactions";

export const metadata: Metadata = { title: "Transactions" };

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

const STATUS: Record<PaymentLine["status"], { label: string; className: string }> = {
  succeeded: { label: "Confirmed", className: "text-brand" },
  failed: { label: "Failed · nothing charged", className: "text-destructive" },
  uncertain: { label: "Outcome unknown · awaiting reconciliation", className: "text-warn" },
  initiated: { label: "In progress", className: "text-ink-soft" },
};

async function TransactionsContent() {
  const { actor, workspace } = await requireWorkspace();
  if (!workspace.buyerProfile) {
    return (
      <PageHeader
        eyebrow="Buying"
        title="Transactions"
        description="Payments made by your engagements as a buyer. Your organization does not buy yet."
      />
    );
  }
  const payments = await listPayments(actor, workspace.organization.id);
  const totals = await getSpendingTotals(actor, workspace.organization.id);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Buying"
        title="Transactions"
        description="Every payment an agent has attempted for you, with the provider's own reference. A payment is shown as confirmed only after it has been verified."
      />

      {totals.length > 0 ? (
        <section aria-label="Total spending" className="grid gap-4 sm:grid-cols-2">
          {totals.map((total) => (
            <div key={`${total.rail}-${total.asset.code}`} className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-start justify-between gap-3">
                <p className="eyebrow">Confirmed spending · {railLabel(total.rail)}</p>
                {total.isSimulated ? <SimulatedBadge /> : null}
              </div>
              <p className="figure mt-3 text-2xl text-foreground">{formatUnits(total.spentUnits, total.asset)}</p>
            </div>
          ))}
        </section>
      ) : null}

      <Panel title="Payments" description="Newest first.">
        {payments.length === 0 ? (
          <EmptyState
            title="No payments yet"
            body="Payments appear here once an agent buys a service under an active engagement."
          />
        ) : (
          <ul className="-my-4 divide-y divide-border">
            {payments.map((payment) => {
              const status = STATUS[payment.status];
              return (
                <li key={payment.id} className="space-y-1.5 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="font-medium text-foreground">
                      {payment.offeringName}{" "}
                      <span className="font-normal text-muted-foreground">· {payment.sellerName}</span>
                    </p>
                    <p className="figure text-foreground">{formatUnits(payment.amountUnits, payment.asset)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className={status.className}>{status.label}</span>
                    <span className="text-muted-foreground">
                      {railLabel(payment.rail)} · {dateTimeFormat.format(payment.createdAt)}
                    </span>
                    {payment.isSimulated ? <SimulatedBadge /> : null}
                    <Link
                      href={`/engagements/${payment.engagementId}`}
                      className="text-ink-soft underline underline-offset-4 hover:text-foreground"
                    >
                      {payment.projectName}
                    </Link>
                  </div>
                  <dl className="grid gap-x-4 gap-y-0.5 text-xs text-muted-foreground sm:grid-cols-[7rem_minmax(0,1fr)]">
                    <dt>Reference</dt>
                    <dd className="figure break-all">{payment.providerRef ?? "None yet"}</dd>
                    <dt>Paid to</dt>
                    <dd className="figure break-all">{payment.recipient}</dd>
                    {payment.failureReason ? (
                      <>
                        <dt>Detail</dt>
                        <dd>{payment.failureReason}</dd>
                      </>
                    ) : null}
                  </dl>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export default function TransactionsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TransactionsContent />
    </Suspense>
  );
}
