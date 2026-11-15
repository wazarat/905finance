import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { EmptyState, PageHeader, Panel, StatTile } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { AutoRefresh } from "@/components/testing/auto-refresh";
import { JobBadge, SeverityTally } from "@/components/testing/badges";
import { Button } from "@/components/ui/button";
import { capabilityLabel } from "@/lib/capabilities";
import { formatDuration } from "@/lib/testing";
import { formatUnits } from "@/lib/units";
import { periodAdjective } from "@/lib/watch";
import { requireWorkspace } from "@/server/page-context";
import { getWorkerStatus } from "@/server/testing/jobs";
import { getTestingOverview, listTestingJobs } from "@/server/testing/reports";

export const metadata: Metadata = { title: "Test reports" };

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

async function ReportsContent() {
  const { actor, workspace } = await requireWorkspace();
  if (!workspace.buyerProfile) {
    return (
      <PageHeader
        eyebrow="Buying"
        title="Test reports"
        description="Results of tests your engagements have bought. Your organization does not buy yet."
      />
    );
  }
  const organizationId = workspace.organization.id;
  const [jobs, overview, worker] = await Promise.all([
    listTestingJobs(actor, organizationId),
    getTestingOverview(actor, organizationId),
    getWorkerStatus(),
  ]);
  const inProgress = overview.jobs.queued + overview.jobs.running;
  const serious = overview.findings.critical + overview.findings.high;

  return (
    <div className="space-y-8">
      {inProgress > 0 ? <AutoRefresh /> : null}
      <PageHeader
        eyebrow="Buying"
        title="Test reports"
        description="Every test an agent has bought for you, with what the testing tool reported. Counts, findings and logs come from the tool's own output; a job with no report yet shows none."
      />

      <section aria-label="Testing summary" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Tests completed" value={String(overview.jobs.completed)} />
        <StatTile
          label="In progress"
          value={String(inProgress)}
          note={
            worker.online
              ? "A testing worker is online."
              : inProgress > 0
                ? "No testing worker is online. Queued tests wait until one is."
                : "No testing worker is online."
          }
        />
        <StatTile label="High or critical findings" value={String(serious)} />
        <StatTile
          label="Could not run"
          value={String(overview.jobs.failed)}
          note={overview.jobs.failed > 0 ? "Paid for, but the test did not complete." : undefined}
        />
      </section>

      <Panel title="Jobs" description="Newest first.">
        {jobs.length === 0 ? (
          <EmptyState
            title="No tests yet"
            body="Reports appear here once an agent buys a test under an active engagement."
            action={
              <Button asChild variant="outline" size="lg" className="h-10 px-4">
                <Link href="/engagements">Go to engagements</Link>
              </Button>
            }
          />
        ) : (
          <ul className="-my-4 divide-y divide-border">
            {jobs.map((job) => (
              <li key={job.id} className="space-y-2 py-4">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <Link
                    href={`/reports/${job.id}`}
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {job.offeringName}
                    <span className="font-normal text-muted-foreground"> · {job.projectName}</span>
                  </Link>
                  {job.watch ? (
                    <Link
                      href={`/watches/${job.watch.id}`}
                      className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                    >
                      Reading {job.watch.reading + 1} of {job.watch.readingsPlanned}
                    </Link>
                  ) : null}
                  <JobBadge status={job.status} outcome={job.result?.outcome} />
                </div>
                <p className="text-sm text-ink-soft">
                  {job.result
                    ? job.result.summary
                    : job.status === "failed"
                      ? (job.failureReason ?? "The test did not complete.")
                      : job.status === "running"
                        ? "A testing worker is executing this now."
                        : "Waiting for a testing worker."}
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                  <span>{capabilityLabel(job.capability)}</span>
                  <span>{job.sellerName}</span>
                  <span>{dateTimeFormat.format(job.createdAt)}</span>
                  {job.result ? <span>{formatDuration(job.result.durationMs)}</span> : null}
                  {job.watch ? (
                    <span>Part of a {periodAdjective(job.watch.periodDays)} watch</span>
                  ) : (
                    <span className="figure">{formatUnits(job.chargeUnits, job.asset)}</span>
                  )}
                  {job.result ? <SeverityTally counts={job.findingCounts} /> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ReportsContent />
    </Suspense>
  );
}
