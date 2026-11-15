import type { TestingJobStatus, TestingOutcome } from "@/db/schema";
import {
  JOB_STATUS_LABELS,
  OUTCOME_LABELS,
  SEVERITIES,
  SEVERITY_LABELS,
  isFindingsReport,
  outcomeLabel,
  type Severity,
} from "@/lib/testing";
import { cn } from "@/lib/utils";
import { READING_STATE_LABELS, WATCH_STATUS_LABELS, type ReadingState, type WatchStatus } from "@/lib/watch";

const pill =
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap";

const NEUTRAL = "border-border bg-muted text-ink-soft";
const GOOD = "border-brand/30 bg-brand-dim text-brand";
const WARN = "border-warn/30 bg-warn-dim text-warn";
const BAD = "border-destructive/30 bg-destructive/10 text-destructive";
const INFO = "border-info/30 bg-info-dim text-info";

/**
 * Where a job stands. Once it has a report, the badge says what the tests
 * found rather than merely that the job finished.
 */
export function JobBadge({
  status,
  outcome,
  tool,
  findings,
}: {
  status: TestingJobStatus;
  outcome?: TestingOutcome | null;
  /** The tool that reported, when known: a look that lists findings is named by what it found. */
  tool?: string | null;
  findings?: number;
}) {
  if (status === "queued") return <span className={cn(pill, NEUTRAL)}>{JOB_STATUS_LABELS.queued}</span>;
  if (status === "running") {
    return (
      <span className={cn(pill, INFO)}>
        <span className="size-1.5 animate-pulse rounded-full bg-info" aria-hidden="true" />
        {JOB_STATUS_LABELS.running}
      </span>
    );
  }
  if (status === "failed" || outcome === "error" || !outcome) {
    return <span className={cn(pill, WARN)}>{JOB_STATUS_LABELS.failed}</span>;
  }
  if (isFindingsReport(tool)) {
    // The look ran and reported. Amber means it found something worth reading, not that anything broke.
    return <span className={cn(pill, outcome === "passed" ? GOOD : WARN)}>{outcomeLabel(outcome, tool, findings)}</span>;
  }
  return <span className={cn(pill, outcome === "passed" ? GOOD : BAD)}>{OUTCOME_LABELS[outcome]}</span>;
}

/** Where a watch stands. */
export function WatchBadge({ status }: { status: WatchStatus }) {
  if (status === "watching") {
    return (
      <span className={cn(pill, INFO)}>
        <span className="size-1.5 animate-pulse rounded-full bg-info" aria-hidden="true" />
        {WATCH_STATUS_LABELS.watching}
      </span>
    );
  }
  return <span className={cn(pill, status === "reported" ? GOOD : WARN)}>{WATCH_STATUS_LABELS[status]}</span>;
}

const READING_TONE: Record<ReadingState, string> = {
  taken: GOOD,
  unreadable: WARN,
  missed: WARN,
  waiting: INFO,
  scheduled: NEUTRAL,
};

/** Whether one reading of a watch was taken. */
export function ReadingBadge({ state }: { state: ReadingState }) {
  return <span className={cn(pill, READING_TONE[state])}>{READING_STATE_LABELS[state]}</span>;
}

const SEVERITY_TONE: Record<Severity, string> = {
  critical: BAD,
  high: BAD,
  medium: WARN,
  low: INFO,
  info: NEUTRAL,
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={cn(pill, SEVERITY_TONE[severity])}>{SEVERITY_LABELS[severity]}</span>;
}

/** Findings per severity, leaving out severities with none. */
export function SeverityTally({ counts }: { counts: Record<Severity, number> }) {
  const present = SEVERITIES.filter((severity) => counts[severity] > 0);
  if (present.length === 0) return <span className="text-xs text-muted-foreground">No findings</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {present.map((severity) => (
        <span key={severity} className={cn(pill, SEVERITY_TONE[severity])}>
          {counts[severity]} {SEVERITY_LABELS[severity].toLowerCase()}
        </span>
      ))}
    </span>
  );
}
