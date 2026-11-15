import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader, Panel, StatTile } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { SimulatedBadge } from "@/components/engagements/badges";
import { ProofTag } from "@/components/proofs/proof-tag";
import { AutoRefresh } from "@/components/testing/auto-refresh";
import { ReadingBadge, SeverityBadge, SeverityTally, WatchBadge } from "@/components/testing/badges";
import { Subject } from "@/components/testing/subject";
import { capabilityLabel } from "@/lib/capabilities";
import { FINDING_CATEGORY_LABELS } from "@/lib/testing";
import { formatUnits } from "@/lib/units";
import {
  TRACKED_STATUS_LABELS,
  cadenceLabel,
  periodLabel,
  type TrackedFinding,
  type TrackedStatus,
} from "@/lib/watch";
import { isAppError } from "@/server/errors";
import { requireWorkspace } from "@/server/page-context";
import { listProofs } from "@/server/proofs";
import { proveAfterwards } from "@/server/prove-afterwards";
import { getWorkerStatus } from "@/server/testing/jobs";
import { advanceWatches, getWatch, type ReadingDetail, type WatchDetail } from "@/server/testing/watches";

export const metadata: Metadata = { title: "Watch" };

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
const dayFormat = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en", { timeStyle: "short" });

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm break-words text-foreground">{children}</dd>
    </div>
  );
}

const GROUPS: TrackedStatus[] = ["appeared", "throughout", "resolved", "came_and_went"];

const GROUP_NOTES: Record<TrackedStatus, string> = {
  appeared: "Not in the first reading, and there in the last.",
  throughout: "In the first reading and still in the last.",
  resolved: "In the first reading, and gone by the last.",
  came_and_went: "In neither the first reading nor the last, but seen in between.",
};

/** "1, 2 and 4" as the readings are numbered for people, from 1. */
function readingList(seenIn: number[], planned: number): string {
  if (seenIn.length === planned) return "every reading";
  const numbers = seenIn.map((reading) => String(reading + 1));
  return `reading${numbers.length === 1 ? "" : "s"} ${numbers.length <= 1 ? numbers.join("") : `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`}`;
}

function TrackedRow({ finding, planned }: { finding: TrackedFinding; planned: number }) {
  return (
    <li className="space-y-2 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <h4 className="min-w-0 font-medium break-words text-foreground">{finding.title}</h4>
        <SeverityBadge severity={finding.severity} />
      </div>
      <p className="text-xs text-muted-foreground">
        {FINDING_CATEGORY_LABELS[finding.category] ?? finding.category}
        {finding.location ? (
          <>
            {" · "}
            <span className="figure break-all">{finding.location}</span>
          </>
        ) : null}
        {" · seen in "}
        {readingList(finding.seenIn, planned)}
      </p>
      {finding.changes.map((change) => (
        <div key={change.reading} className="rounded-lg border border-warn/30 bg-warn-dim p-3">
          <p className="text-xs font-medium text-foreground">
            What was read about it changed at reading {change.reading + 1}
          </p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <p className="eyebrow">Before</p>
              <pre className="figure mt-1 max-h-40 overflow-auto text-xs leading-relaxed whitespace-pre-wrap text-ink-soft">
                {change.before}
              </pre>
            </div>
            <div className="min-w-0">
              <p className="eyebrow">After</p>
              <pre className="figure mt-1 max-h-40 overflow-auto text-xs leading-relaxed whitespace-pre-wrap text-ink-soft">
                {change.after}
              </pre>
            </div>
          </div>
        </div>
      ))}
    </li>
  );
}

function PeriodReport({ watch }: { watch: WatchDetail }) {
  const { report } = watch;
  if (report.taken === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {watch.status === "watching"
          ? "No reading has been taken yet, so there is nothing to compare."
          : "No reading could be taken, so there is nothing to report. Nothing has been made up in its place."}
      </p>
    );
  }
  if (!report.comparable) {
    return (
      <p className="text-sm leading-relaxed text-muted-foreground">
        {watch.status === "watching"
          ? "One reading has been taken. The comparison starts with the second."
          : `Only one reading was taken, so there is nothing to compare it with. It found ${report.tracked.length} ${report.tracked.length === 1 ? "thing" : "things"}; its own report has the detail.`}
      </p>
    );
  }
  if (report.tracked.length === 0) {
    return <p className="text-sm text-muted-foreground">No reading found anything.</p>;
  }
  return (
    <div className="space-y-8">
      {GROUPS.map((status) => {
        const group = report.tracked.filter((finding) => finding.status === status);
        if (group.length === 0) return null;
        return (
          <section key={status} aria-label={TRACKED_STATUS_LABELS[status]}>
            <h3 className="text-sm font-semibold text-foreground">
              {TRACKED_STATUS_LABELS[status]} <span className="font-normal text-muted-foreground">· {group.length}</span>
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{GROUP_NOTES[status]}</p>
            <ul className="mt-1 divide-y divide-border">
              {group.map((finding) => (
                <TrackedRow key={finding.key} finding={finding} planned={watch.readingsPlanned} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function readingNote(reading: ReadingDetail, watch: WatchDetail): string {
  if (reading.state === "taken") {
    const delta = watch.report.deltas.find((entry) => entry.reading === reading.reading);
    if (!delta) return reading.reading === watch.report.first ? "The reading the others are compared with." : "";
    const parts = [
      delta.appeared > 0 ? `${delta.appeared} new` : "",
      delta.gone > 0 ? `${delta.gone} gone` : "",
      delta.changed > 0 ? `${delta.changed} changed` : "",
    ].filter(Boolean);
    return parts.length > 0 ? `Since the reading before: ${parts.join(", ")}.` : "The same as the reading before.";
  }
  if (reading.state === "waiting") {
    return reading.jobId ? "Waiting for a testing worker to take it." : "Due. It is queued when a testing worker next checks in.";
  }
  return reading.note ?? "";
}

async function WatchContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { actor, workspace } = await requireWorkspace();
  let watch: WatchDetail;
  try {
    // Looking at a watch moves its schedule forward, the same as a worker checking in does.
    watch = await getWatch(actor, id);
    if (watch.status === "watching") {
      const progress = await advanceWatches({ watchId: watch.id });
      if (progress.finished > 0) proveAfterwards();
      if (progress.finished > 0 || progress.queued > 0) watch = await getWatch(actor, id);
    }
  } catch (error) {
    if (isAppError(error) && error.code === "not_found") notFound();
    throw error;
  }
  const organizationId = workspace.organization.id;
  const taken = watch.readings.filter((reading) => reading.jobId !== null && reading.state === "taken");
  const [periodProofs, readingProofs, worker] = await Promise.all([
    listProofs(actor, organizationId, "period", [watch.id]),
    listProofs(
      actor,
      organizationId,
      "report",
      taken.map((reading) => reading.jobId!),
    ),
    getWorkerStatus(),
  ]);
  const periodProof = periodProofs.get(watch.id);
  const inFlight = watch.readings.some((reading) => reading.state === "waiting" && reading.jobId !== null);
  const next = watch.readings.find((reading) => reading.state === "scheduled" || reading.state === "waiting");
  const gaps = watch.report.missed + watch.report.unreadable;
  const finished = watch.status !== "watching";

  return (
    <div className="space-y-8">
      {inFlight ? <AutoRefresh /> : null}
      <Link
        href="/watches"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        All watches
      </Link>

      <PageHeader
        eyebrow={`${capabilityLabel(watch.capability)} · over ${periodLabel(watch.periodDays)} · ${watch.projectName}`}
        title={watch.offeringName}
        description={
          watch.summary ??
          `${watch.sellerName} reads this ${cadenceLabel(watch.everyHours)} for ${periodLabel(watch.periodDays)} and reports once at the end. ${watch.readingsTaken} of ${watch.readingsPlanned} readings taken so far.`
        }
        actions={
          <span className="self-center">
            <WatchBadge status={watch.status} />
          </span>
        }
      />

      {!finished && !worker.online ? (
        <div className="rounded-xl border border-warn/30 bg-warn-dim p-5">
          <p className="font-medium text-foreground">No testing worker is online</p>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-soft">
            Readings are taken by a testing worker. While none is online, readings that come due are missed, and the
            period report will say so. Nothing is filled in for a reading that was not taken.
          </p>
        </div>
      ) : null}

      <section aria-label="Watch progress" className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Readings taken" value={`${watch.readingsTaken} of ${watch.readingsPlanned}`} />
        <StatTile
          label="Not taken"
          value={String(gaps)}
          note={
            gaps > 0
              ? [
                  watch.report.missed > 0 ? `${watch.report.missed} missed` : "",
                  watch.report.unreadable > 0 ? `${watch.report.unreadable} could not be read` : "",
                ]
                  .filter(Boolean)
                  .join(", ")
              : undefined
          }
        />
        <StatTile
          label="Next reading"
          value={finished || !next ? null : dayFormat.format(next.dueAt)}
          note={
            finished || !next
              ? "The watch has ended."
              : next.state === "waiting"
                ? "Due now."
                : `At ${timeFormat.format(next.dueAt)}.`
          }
        />
        <StatTile
          label="Period report"
          value={dayFormat.format(finished ? (watch.finishedAt ?? watch.endsAt) : watch.endsAt)}
          note={
            finished
              ? `Written at ${timeFormat.format(watch.finishedAt ?? watch.endsAt)}.`
              : `Due after the last reading, at ${timeFormat.format(watch.endsAt)}.`
          }
        />
      </section>

      <Panel
        title={finished ? "Period report" : "So far"}
        description={
          finished
            ? "What the readings found, compared with each other. Only readings that were taken are compared."
            : "The same comparison the period report will make, over the readings taken so far. It is not final."
        }
        action={finished ? <ProofTag proof={periodProof} /> : null}
      >
        <PeriodReport watch={watch} />
      </Panel>

      <Panel
        title="Readings"
        description="Each reading is a full report of its own, with its own proof. The first is the first look."
      >
        <ol className="-my-4 divide-y divide-border">
          {watch.readings.map((reading) => (
            <li key={reading.reading} className="space-y-1.5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <p className="font-medium text-foreground">
                  Reading {reading.reading + 1}
                  {reading.reading === 0 ? (
                    <span className="font-normal text-muted-foreground"> · first look</span>
                  ) : reading.reading === watch.readingsPlanned - 1 ? (
                    <span className="font-normal text-muted-foreground"> · last</span>
                  ) : null}
                </p>
                <ReadingBadge state={reading.state} />
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                <span>
                  {reading.takenAt
                    ? `Taken ${dateTimeFormat.format(reading.takenAt)}`
                    : `Due ${dateTimeFormat.format(reading.dueAt)}`}
                </span>
                {reading.state === "taken" ? <SeverityTally counts={reading.counts} /> : null}
                {reading.jobId && reading.state !== "waiting" ? (
                  <Link
                    href={`/reports/${reading.jobId}`}
                    className="text-foreground underline underline-offset-4 hover:text-brand"
                  >
                    {reading.state === "taken" ? "View report" : "View details"}
                  </Link>
                ) : null}
                {reading.jobId ? <ProofTag proof={readingProofs.get(reading.jobId)} /> : null}
              </div>
              {readingNote(reading, watch) ? (
                <p className="text-sm text-ink-soft">{readingNote(reading, watch)}</p>
              ) : null}
            </li>
          ))}
        </ol>
      </Panel>

      <Panel title="Watch" description="What is read, by whom, for how long, and what it cost.">
        <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="What is read">
            <Subject source={watch.source} fixtureKey="" />
          </Fact>
          <Fact label="Project">
            <Link href={`/projects/${watch.projectId}`} className="underline underline-offset-4">
              {watch.projectName}
            </Link>
          </Fact>
          <Fact label="Seller">{watch.sellerName}</Fact>
          <Fact label="Period">
            {periodLabel(watch.periodDays)}, read {cadenceLabel(watch.everyHours)}
            <span className="block text-xs text-muted-foreground">{watch.readingsPlanned} readings planned</span>
          </Fact>
          <Fact label="Started">{dateTimeFormat.format(watch.startedAt)}</Fact>
          <Fact label="Last reading due">{dateTimeFormat.format(watch.endsAt)}</Fact>
          <Fact label="Charge for the whole watch">
            <span className="figure">{formatUnits(watch.chargeUnits, watch.asset)}</span>
            {watch.isSimulatedPayment ? <SimulatedBadge className="ml-2" /> : null}
            <span className="block text-xs text-muted-foreground">Paid once, before the first reading.</span>
          </Fact>
          <Fact label="Engagement">
            <Link href={`/engagements/${watch.engagementId}`} className="underline underline-offset-4">
              View engagement
            </Link>
            <span className="block text-xs text-muted-foreground">
              The watch is paid for, so it carries on if the engagement ends first.
            </span>
          </Fact>
          {periodProof ? (
            <Fact label="Proof of the period report">
              <ProofTag proof={periodProof} />
            </Fact>
          ) : null}
          <Fact label="Watch ID">
            <span className="figure break-all">{watch.id}</span>
          </Fact>
        </dl>
      </Panel>
    </div>
  );
}

export default function WatchPage({ params }: PageProps<"/watches/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <WatchContent params={params} />
    </Suspense>
  );
}
