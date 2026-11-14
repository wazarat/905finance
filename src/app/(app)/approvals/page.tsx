import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { EmptyState, PageHeader, Panel } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { Button } from "@/components/ui/button";
import { formatUnits } from "@/lib/units";
import { cn } from "@/lib/utils";
import { listApprovals, type ApprovalSummary } from "@/server/approvals";
import { requireWorkspace } from "@/server/page-context";

export const metadata: Metadata = { title: "Approvals" };

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

const KIND_LABELS = { budget_increase: "Budget increase", additional_funding: "Additional funding" } as const;

function outcome(approval: ApprovalSummary): { label: string; className: string } {
  switch (approval.status) {
    case "approved":
      return approval.kind === "budget_increase" && approval.approvedTotalUnits !== null
        ? {
            label: `Approved · budget raised to ${formatUnits(approval.approvedTotalUnits, approval.asset)}`,
            className: "text-brand",
          }
        : { label: "Answered by a funding authorization", className: "text-brand" };
    case "rejected":
      return { label: "Declined", className: "text-ink-soft" };
    case "modified":
      return { label: approval.decisionNote || "Work changed", className: "text-ink-soft" };
    case "cancelled":
      return { label: "Closed · engagement ended", className: "text-muted-foreground" };
    default:
      return { label: "Waiting for your decision", className: "text-warn" };
  }
}

function ApprovalRow({ approval }: { approval: ApprovalSummary }) {
  const result = outcome(approval);
  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-foreground">
          {KIND_LABELS[approval.kind]} · {approval.sellerName}
        </p>
        <p className="text-sm text-muted-foreground">
          {approval.offeringName} for {formatUnits(approval.proposedAmountUnits, approval.asset)} ·{" "}
          {approval.kind === "budget_increase" ? "budget short by " : "wallet short by "}
          {formatUnits(approval.shortfallUnits, approval.asset)}
        </p>
        <p className="text-xs text-muted-foreground">
          {approval.projectName} · requested {dateTimeFormat.format(approval.createdAt)}
        </p>
        <p className={cn("text-sm", result.className)}>{result.label}</p>
      </div>
      <Button
        asChild
        variant={approval.status === "pending" ? "default" : "outline"}
        size="lg"
        className="h-10 shrink-0 px-4"
      >
        <Link href={`/engagements/${approval.engagementId}`}>
          {approval.status === "pending" ? "Review and decide" : "View engagement"}
        </Link>
      </Button>
    </li>
  );
}

async function ApprovalsContent() {
  const { actor, workspace } = await requireWorkspace();
  if (!workspace.buyerProfile) {
    return (
      <PageHeader
        eyebrow="Buying"
        title="Approvals"
        description="Approval requests come from your engagements as a buyer. Your organization does not buy yet."
      />
    );
  }
  const approvals = await listApprovals(actor, workspace.organization.id);
  const pending = approvals.filter((a) => a.status === "pending");
  const decided = approvals.filter((a) => a.status !== "pending");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Buying"
        title="Approvals"
        description="When an agent needs more budget or more funds, it stops and asks. Nothing is bought until you decide."
      />

      <Panel title="Waiting for you" description="Each engagement is paused until its request is decided.">
        {pending.length === 0 ? (
          <EmptyState
            title="Nothing needs your decision"
            body="Requests appear here when an agent's next purchase would exceed its budget or its wallet."
          />
        ) : (
          <ul className="-my-4 divide-y divide-border">
            {pending.map((approval) => (
              <ApprovalRow key={approval.id} approval={approval} />
            ))}
          </ul>
        )}
      </Panel>

      {decided.length > 0 ? (
        <Panel title="Decided" description="Past requests and what happened to them.">
          <ul className="-my-4 divide-y divide-border">
            {decided.map((approval) => (
              <ApprovalRow key={approval.id} approval={approval} />
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

export default function ApprovalsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ApprovalsContent />
    </Suspense>
  );
}
