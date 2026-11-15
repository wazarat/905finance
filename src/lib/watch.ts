import { BILLING_UNIT_LABELS } from "./capabilities";
import { SEVERITIES, type Severity } from "./testing";

/**
 * Work over a period.
 *
 * A seller can sell a watch: the same read-only look, taken again and again
 * over a number of days, ending in one report of what stayed, what appeared,
 * what was fixed and what changed. The first reading is taken straight away
 * and is the buyer's first look.
 *
 * Everything here is arithmetic over readings that were really taken. A
 * reading that was not taken is reported as not taken, and nothing is
 * filled in for it.
 */

export const WATCH_PERIODS = [1, 5, 10] as const;
export type WatchPeriod = (typeof WATCH_PERIODS)[number];

const HOUR_MS = 3_600_000;
/** How long after a watch's last reading is due a worker may still take it. */
export const FINAL_GRACE_MS = 6 * HOUR_MS;

export function isWatchPeriod(days: unknown): days is WatchPeriod {
  return typeof days === "number" && (WATCH_PERIODS as readonly number[]).includes(days);
}

/** A one-day watch reads every six hours; a longer one reads once a day. */
export function readingEveryHours(periodDays: number): number {
  return periodDays <= 1 ? 6 : 24;
}

/** Readings in a watch, counting the first look and the one at the very end. */
export function readingsPlanned(periodDays: number): number {
  return Math.round((periodDays * 24) / readingEveryHours(periodDays)) + 1;
}

export function periodLabel(periodDays: number): string {
  return periodDays === 1 ? "1 day" : `${periodDays} days`;
}

/** "5-day", for use before a noun. */
export function periodAdjective(periodDays: number): string {
  return `${periodDays}-day`;
}

/** What a price buys: "per run" for work done once, "for 5 days" for a watch. */
export function offeringTerms(offering: { billingUnit: keyof typeof BILLING_UNIT_LABELS; periodDays: number | null }): string {
  return offering.periodDays ? `for ${periodLabel(offering.periodDays)}` : BILLING_UNIT_LABELS[offering.billingUnit];
}

/** A sentence for a listing: how often a watch reads, and when its report comes. */
export function watchPlanLabel(periodDays: number): string {
  return `${readingsPlanned(periodDays)} readings, ${cadenceLabel(readingEveryHours(periodDays))}: a first look straight away, and one report at the end.`;
}

/** "every 6 hours" or "once a day". */
export function cadenceLabel(everyHours: number): string {
  return everyHours === 24 ? "once a day" : `every ${everyHours} hours`;
}

export type WatchSchedule = { startedAt: Date; everyHours: number; readingsPlanned: number };

/** When a reading is due. Readings are numbered from 0, the first look. */
export function readingDueAt(watch: WatchSchedule, reading: number): Date {
  return new Date(watch.startedAt.getTime() + reading * watch.everyHours * HOUR_MS);
}

export function watchEndsAt(watch: WatchSchedule): Date {
  return readingDueAt(watch, watch.readingsPlanned - 1);
}

/** The reading whose turn it is at a moment: the latest one that has come due. */
export function readingDueNow(watch: WatchSchedule, now: Date): number {
  const elapsed = Math.floor((now.getTime() - watch.startedAt.getTime()) / (watch.everyHours * HOUR_MS));
  return Math.min(Math.max(elapsed, 0), watch.readingsPlanned - 1);
}

/** Until when a reading may still be taken: the next one's due time, or a grace period after the last. */
export function readingClosesAt(watch: WatchSchedule, reading: number): Date {
  return reading >= watch.readingsPlanned - 1
    ? new Date(watchEndsAt(watch).getTime() + FINAL_GRACE_MS)
    : readingDueAt(watch, reading + 1);
}

// ---------------------------------------------------------------------------
// Comparing readings
// ---------------------------------------------------------------------------

export type WatchFinding = {
  title: string;
  severity: Severity;
  category: string;
  location: string;
  evidence: string;
  code?: { file: string; startLine: number; highlightStart: number; highlightEnd: number; lines: string[] } | null;
};

/**
 * taken: the tool ran and reported. unreadable: the tool ran and could not
 * finish (a site that did not answer, say). missed: no worker took it in
 * time. waiting: due, and not taken yet. scheduled: not due yet.
 */
export type ReadingState = "taken" | "unreadable" | "missed" | "waiting" | "scheduled";

export type WatchReading = {
  reading: number;
  state: ReadingState;
  findings: readonly WatchFinding[];
};

/**
 * What makes a finding in one reading the same finding in another. Line
 * numbers move as a file is edited and counts tick down ("expires in 12
 * days"), so neither is part of it: a finding is its kind, its wording with
 * numbers set aside, the file or place, and the text of the lines it points at.
 */
export function findingIdentity(finding: WatchFinding): string {
  const place = finding.code?.file ?? finding.location.replace(/:\d+(?::\d+)?$/, "");
  const text = finding.code
    ? finding.code.lines
        .slice(finding.code.highlightStart - finding.code.startLine, finding.code.highlightEnd - finding.code.startLine + 1)
        .map((line) => line.trim())
        .join("\n")
    : "";
  return [finding.category, finding.title.replace(/\d+/g, "#"), place, text].join("\u0000");
}

/** Findings whose evidence quotes what was read, so that a different quote means the thing itself changed. */
const QUOTED_CATEGORIES = new Set(["observation", "configuration"]);

export type TrackedStatus = "throughout" | "appeared" | "resolved" | "came_and_went";

export type TrackedFinding = {
  key: string;
  /** As worded in the last reading that had it. */
  title: string;
  severity: Severity;
  category: string;
  location: string;
  status: TrackedStatus;
  /** Readings that had it, by number. */
  seenIn: number[];
  /** Times what was read about it differed from the reading before. */
  changes: Array<{ reading: number; before: string; after: string }>;
};

export type ReadingDelta = { reading: number; appeared: number; gone: number; changed: number };

export type WatchSummary = {
  planned: number;
  taken: number;
  unreadable: number;
  missed: number;
  /** False until two readings have been taken: with one there is nothing to compare. */
  comparable: boolean;
  first: number | null;
  last: number | null;
  tracked: TrackedFinding[];
  counts: Record<TrackedStatus, number> & { changed: number };
  /** What differed at each reading from the one taken before it. */
  deltas: ReadingDelta[];
};

const severityRank = new Map<string, number>(SEVERITIES.map((severity, index) => [severity, index]));
const STATUS_ORDER: TrackedStatus[] = ["appeared", "throughout", "resolved", "came_and_went"];

/** Compare a watch's readings. Only readings that were taken are compared. */
export function summarizeWatch(planned: number, readings: readonly WatchReading[]): WatchSummary {
  const taken = readings.filter((entry) => entry.state === "taken").sort((a, b) => a.reading - b.reading);
  const first = taken[0]?.reading ?? null;
  const last = taken.at(-1)?.reading ?? null;
  const tracked = new Map<string, TrackedFinding>();
  /** What each finding's evidence said in the last reading that had it. */
  const said = new Map<string, string>();
  const deltas: ReadingDelta[] = [];

  let previous: Map<string, WatchFinding> | null = null;
  for (const entry of taken) {
    const current = new Map<string, WatchFinding>();
    for (const finding of entry.findings) {
      const key = findingIdentity(finding);
      if (!current.has(key)) current.set(key, finding);
    }
    const delta: ReadingDelta = { reading: entry.reading, appeared: 0, gone: 0, changed: 0 };
    for (const [key, finding] of current) {
      const known = tracked.get(key);
      if (!known) {
        tracked.set(key, {
          key,
          title: finding.title,
          severity: finding.severity,
          category: finding.category,
          location: finding.location,
          status: "throughout",
          seenIn: [entry.reading],
          changes: [],
        });
      } else {
        const before = said.get(key) ?? "";
        if (QUOTED_CATEGORIES.has(finding.category) && previous?.has(key) && before !== finding.evidence) {
          known.changes.push({ reading: entry.reading, before, after: finding.evidence });
          delta.changed += 1;
        }
        known.seenIn.push(entry.reading);
        known.title = finding.title;
        known.severity = finding.severity;
        known.location = finding.location;
      }
      said.set(key, finding.evidence);
      if (previous && !previous.has(key)) delta.appeared += 1;
    }
    if (previous) {
      for (const key of previous.keys()) if (!current.has(key)) delta.gone += 1;
      deltas.push(delta);
    }
    previous = current;
  }

  const counts: WatchSummary["counts"] = { throughout: 0, appeared: 0, resolved: 0, came_and_went: 0, changed: 0 };
  const list: TrackedFinding[] = [];
  for (const entry of tracked.values()) {
    const atStart = entry.seenIn.includes(first!);
    const atEnd = entry.seenIn.includes(last!);
    entry.status = atStart && atEnd ? "throughout" : atEnd ? "appeared" : atStart ? "resolved" : "came_and_went";
    counts[entry.status] += 1;
    if (entry.changes.length > 0) counts.changed += 1;
    list.push(entry);
  }
  list.sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      severityRank.get(a.severity)! - severityRank.get(b.severity)! ||
      a.title.localeCompare(b.title),
  );

  return {
    planned,
    taken: taken.length,
    unreadable: readings.filter((entry) => entry.state === "unreadable").length,
    missed: readings.filter((entry) => entry.state === "missed").length,
    comparable: taken.length >= 2,
    first,
    last,
    tracked: list,
    counts,
    deltas,
  };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** One or two sentences stating how a finished watch went, from its summary alone. */
export function describeWatch(periodDays: number, summary: WatchSummary): string {
  const readings = `${summary.taken} of ${summary.planned} readings were taken`;
  const gaps = [
    summary.missed > 0 ? `${summary.missed} missed` : "",
    summary.unreadable > 0 ? `${summary.unreadable} could not be read` : "",
  ].filter(Boolean);
  const head = `${periodAdjective(periodDays)} watch: ${readings}${gaps.length > 0 ? ` (${gaps.join(", ")})` : ""}.`;
  if (summary.taken === 0) return `${head} There is nothing to report.`;
  if (!summary.comparable) {
    return `${head} ${plural(summary.tracked.length, "finding", "findings")} in the one reading taken, with nothing to compare it with.`;
  }
  const { counts } = summary;
  const parts = [
    `${plural(counts.throughout, "finding was", "findings were")} there from start to end`,
    `${counts.appeared} appeared`,
    `${counts.resolved} ${counts.resolved === 1 ? "was" : "were"} resolved`,
  ];
  if (counts.came_and_went > 0) parts.push(`${counts.came_and_went} came and went`);
  if (counts.changed > 0) parts.push(`${counts.changed} changed in what was read`);
  return `${head} ${parts.join(", ")}.`;
}

export const TRACKED_STATUS_LABELS: Record<TrackedStatus, string> = {
  appeared: "Appeared during the watch",
  throughout: "There from start to end",
  resolved: "Resolved during the watch",
  came_and_went: "Came and went",
};

export const READING_STATE_LABELS: Record<ReadingState, string> = {
  taken: "Taken",
  unreadable: "Could not be read",
  missed: "Missed",
  waiting: "Due now",
  scheduled: "Scheduled",
};

export const WATCH_STATUS_LABELS = {
  watching: "Watching",
  reported: "Report ready",
  failed: "No readings taken",
} as const;

export type WatchStatus = keyof typeof WATCH_STATUS_LABELS;
