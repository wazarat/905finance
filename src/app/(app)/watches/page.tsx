import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { EmptyState, PageHeader, Panel, StatTile } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { WatchBadge } from "@/components/testing/badges";
import { Button } from "@/components/ui/button";
import { capabilityLabel } from "@/lib/capabilities";
import { formatUnits } from "@/lib/units";
import { cadenceLabel, periodLabel } from "@/lib/watch";
import { requireWorkspace } from "@/server/page-context";
import { proveAfterwards } from "@/server/prove-afterwards";
import { getWorkerStatus } from "@/server/testing/jobs";
import { advanceWatches, listWatches } from "@/server/testing/watches";

export const metadata: Metadata = { title: "Watches" };

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

async function WatchesContent() {
  const { actor, workspace } = await requireWorkspace();
  if (!workspace.buyerProfile) {
    return (
      <PageHeader
        eyebrow="Buying"
        title="Watches"
        description="Work your engagements have bought over a period. Your organization does not buy yet."
      />
    );
  }
  const organizationId = workspace.organization.id;
  let watches = await listWatches(actor, organizationId);
  if (watches.some((watch) => watch.status === "watching")) {
    const progress = await advanceWatches();
    if (progress.finished > 0) proveAfterwards();
    if (progress.finished > 0 || progress.queued > 0) watches = await listWatches(actor, organizationId);
  }
  const worker = await getWorkerStatus();
  const running = watches.filter((watch) => watch.status === "watching");
  const reported = watches.filter((watch) => watch.status === "reported");

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Buying"
        title="Watches"
        description="Work a seller does over a period: the same look taken again and again, with a first look straight away and one report at the end saying what stayed, what appeared and what was fixed."
      />

      <section aria-label="Watches summary" className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <StatTile
          label="Watching now"
          value={String(running.length)}
          note={
            running.length === 0
              ? undefined
              : worker.online
                ? "A testing worker is online."
                : "No testing worker is online. Readings that come due are missed."
          }
        />
        <StatTile label="Period reports ready" value={String(reported.length)} />
        <StatTile
          label="Readings taken"
          value={String(watches.reduce((sum, watch) => sum + watch.readingsTaken, 0))}
        />
      </section>

      <Panel title="Watches" description="Newest first.">
        {watches.length === 0 ? (
          <EmptyState
            title="No watches yet"
            body="A watch appears here once an agent buys work over a period, such as a 5-day website watch, under an active engagement."
            action={
              <Button asChild variant="outline" size="lg" className="h-10 px-4">
                <Link href="/agents">Explore agents</Link>
              </Button>
            }
          />
        ) : (
          <ul className="-my-4 divide-y divide-border">
            {watches.map((watch) => (
              <li key={watch.id} className="space-y-2 py-4">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <Link
                    href={`/watches/${watch.id}`}
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {watch.offeringName}
                    <span className="font-normal text-muted-foreground"> · {watch.projectName}</span>
                  </Link>
                  <WatchBadge status={watch.status} />
                </div>
                <p className="text-sm text-ink-soft">
                  {watch.summary ??
                    `${watch.readingsTaken} of ${watch.readingsPlanned} readings taken. The report is due after ${dateTimeFormat.format(watch.endsAt)}.`}
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                  <span>{capabilityLabel(watch.capability)}</span>
                  <span>
                    {periodLabel(watch.periodDays)}, {cadenceLabel(watch.everyHours)}
                  </span>
                  <span>{watch.sellerName}</span>
                  <span>Started {dateTimeFormat.format(watch.startedAt)}</span>
                  <span className="figure">{formatUnits(watch.chargeUnits, watch.asset)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export default function WatchesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <WatchesContent />
    </Suspense>
  );
}
