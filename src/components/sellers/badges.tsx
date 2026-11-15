import type { ListingStatus } from "@/db/schema";
import { capabilityLabel, isWeb3Capability } from "@/lib/capabilities";
import { cn } from "@/lib/utils";

const pill =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap";

const STATUS: Record<ListingStatus, { label: string; className: string; dot: string }> = {
  draft: {
    label: "Draft",
    className: "border-border bg-muted text-ink-soft",
    dot: "bg-muted-foreground",
  },
  pending_review: {
    label: "Awaiting review",
    className: "border-warn/30 bg-warn-dim text-warn",
    dot: "bg-warn",
  },
  active: {
    label: "Live",
    className: "border-brand/30 bg-brand-dim text-brand",
    dot: "bg-brand",
  },
  suspended: {
    label: "Suspended",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
};

export function ListingStatusBadge({ status }: { status: ListingStatus }) {
  const s = STATUS[status];
  return (
    <span className={cn(pill, s.className)}>
      <span className={cn("size-1.5 rounded-full", s.dot)} aria-hidden="true" />
      {s.label}
    </span>
  );
}

export function CapabilityChip({ capability }: { capability: string }) {
  const web3 = isWeb3Capability(capability);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-1 text-xs",
        web3 ? "border-info/25 bg-info-dim text-info" : "border-border bg-muted text-ink-soft",
      )}
    >
      {capabilityLabel(capability)}
    </span>
  );
}

export function Web3Badge({ className }: { className?: string }) {
  return (
    <span className={cn(pill, "border-info/25 bg-info-dim text-info", className)}>Web3</span>
  );
}

/** Used wherever an integration that arrives in a later milestone would appear. */
export function NotConnectedBadge({ label = "Not connected" }: { label?: string }) {
  return <span className={cn(pill, "border-border bg-transparent text-muted-foreground")}>{label}</span>;
}
