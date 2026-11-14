import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1 className={cn("text-3xl font-semibold text-balance text-foreground", eyebrow && "mt-2")}>
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-2xl leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

/** A metric tile. `value` of null renders a dash with a "not yet active" note instead of a fake zero. */
export function StatTile({
  label,
  value,
  note,
}: {
  label: string;
  value: string | null;
  note?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <p className="eyebrow">{label}</p>
      <p
        className={cn(
          "figure mt-3 text-3xl",
          value === null ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {value ?? "—"}
      </p>
      {note ? <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{note}</p> : null}
    </div>
  );
}

export function Panel({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-border bg-card", className)}>
      <div className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 py-2">
      <div>
        <p className="font-medium text-foreground">{title}</p>
        <p className="mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
      {action}
    </div>
  );
}

/** Labels a capability that is designed but switched on in a later release. */
export function NotYetActive({ children }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[0.6875rem] text-muted-foreground">
      {children ?? "Not yet active"}
    </span>
  );
}
