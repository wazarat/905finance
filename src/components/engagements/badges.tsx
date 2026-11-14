import { Check } from "lucide-react";
import type { EngagementState, WalletStatus } from "@/db/schema";
import {
  ENGAGEMENT_STATE_LABELS,
  ENGAGEMENT_STEPS,
  isTerminal,
  stepIsComplete,
} from "@/lib/engagement-state";
import { cn } from "@/lib/utils";

const pill =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap";

const STATE_TONE: Record<EngagementState, { className: string; dot: string }> = {
  DISCOVERING: { className: "border-border bg-muted text-ink-soft", dot: "bg-muted-foreground" },
  SELLER_SELECTED: { className: "border-border bg-muted text-ink-soft", dot: "bg-muted-foreground" },
  AUTHORIZED: { className: "border-info/30 bg-info-dim text-info", dot: "bg-info" },
  WALLET_PROVISIONED: { className: "border-info/30 bg-info-dim text-info", dot: "bg-info" },
  AWAITING_FUNDING: { className: "border-warn/30 bg-warn-dim text-warn", dot: "bg-warn" },
  ACTIVE: { className: "border-brand/30 bg-brand-dim text-brand", dot: "bg-brand" },
  PAUSED_FOR_APPROVAL: { className: "border-warn/30 bg-warn-dim text-warn", dot: "bg-warn" },
  COMPLETED: { className: "border-border bg-muted text-ink-soft", dot: "bg-muted-foreground" },
  CANCELLED: { className: "border-border bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
  EXPIRED: { className: "border-border bg-muted text-muted-foreground", dot: "bg-muted-foreground" },
  FAILED: {
    className: "border-destructive/30 bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
};

export function EngagementStateBadge({ state }: { state: EngagementState }) {
  const tone = STATE_TONE[state];
  return (
    <span className={cn(pill, tone.className)}>
      <span className={cn("size-1.5 rounded-full", tone.dot)} aria-hidden="true" />
      {ENGAGEMENT_STATE_LABELS[state]}
    </span>
  );
}

const WALLET_LABELS: Record<WalletStatus, string> = {
  provisioning: "Provisioning",
  awaiting_funding: "Awaiting funding",
  active: "Active",
  suspended: "Suspended",
  closing: "Closing · funds held",
  closed: "Closed",
};

export function WalletStatusBadge({ status }: { status: WalletStatus }) {
  const tone =
    status === "active"
      ? "border-brand/30 bg-brand-dim text-brand"
      : status === "awaiting_funding" || status === "closing"
        ? "border-warn/30 bg-warn-dim text-warn"
        : "border-border bg-muted text-ink-soft";
  return <span className={cn(pill, tone)}>{WALLET_LABELS[status]}</span>;
}

/** Marks balances and wallets that have no real asset behind them. */
export function SimulatedBadge({ className, label = "Simulated" }: { className?: string; label?: string }) {
  return (
    <span
      className={cn(pill, "border-warn/30 bg-warn-dim text-warn", className)}
      title="No real asset or account is involved. Balances are kept by 905 Finance for demonstration."
    >
      {label}
    </span>
  );
}

/** The four decisions a buyer makes to activate an engagement. */
export function EngagementStepper({ state }: { state: EngagementState }) {
  const ended = isTerminal(state);
  return (
    <ol className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
      {ENGAGEMENT_STEPS.map((step, index) => {
        const done = stepIsComplete(state, step.reachedAt);
        const current =
          !ended && !done && (index === 0 || stepIsComplete(state, ENGAGEMENT_STEPS[index - 1].reachedAt));
        return (
          <li
            key={step.key}
            aria-current={current ? "step" : undefined}
            className={cn("flex items-center gap-3 bg-card px-4 py-3", current && "bg-accent/60")}
          >
            <span
              className={cn(
                "figure flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
                done
                  ? "border-brand/40 bg-brand-dim text-brand"
                  : current
                    ? "border-foreground/40 text-foreground"
                    : "border-border text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3.5" aria-hidden="true" /> : index + 1}
            </span>
            <span
              className={cn(
                "text-sm",
                done ? "text-ink-soft" : current ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {step.label}
              <span className="sr-only">{done ? " (done)" : current ? " (current step)" : ""}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
