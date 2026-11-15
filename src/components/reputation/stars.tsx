import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

/** One to five stars, as a row of icons with the figure spoken for screen readers. */
export function Stars({ stars, className }: { stars: number; className?: string }) {
  const filled = Math.round(stars);
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} role="img" aria-label={`${stars} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((position) => (
        <Star
          key={position}
          aria-hidden="true"
          className={cn("size-4", position <= filled ? "fill-warn text-warn" : "text-muted-foreground/50")}
        />
      ))}
    </span>
  );
}

export const CASE_STATUS = {
  open: { label: "Under review by 905 Finance", className: "border-warn/30 bg-warn-dim text-warn" },
  upheld: { label: "Complaint upheld", className: "border-destructive/30 bg-destructive/10 text-destructive" },
  not_upheld: { label: "Complaint not upheld", className: "border-border bg-muted text-ink-soft" },
} as const;

export function CaseStatusBadge({ status }: { status: string }) {
  const entry = CASE_STATUS[status as keyof typeof CASE_STATUS] ?? CASE_STATUS.open;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap",
        entry.className,
      )}
    >
      {entry.label}
    </span>
  );
}

export const averageLabel = (tenths: number) => `${Math.floor(tenths / 10)}.${tenths % 10}`;
