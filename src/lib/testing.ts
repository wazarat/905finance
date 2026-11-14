/**
 * Shared vocabulary for testing jobs and their results. Pure functions only:
 * everything here describes figures that a testing tool reported, and nothing
 * here produces a figure of its own.
 */

export const TESTING_TOOLS = {
  vitest: "Vitest",
  forge: "Foundry",
  slither: "Slither",
} as const;

export type TestingTool = keyof typeof TESTING_TOOLS;

/** The tool that must have produced a result for each test type. */
export const CAPABILITY_TOOLS: Record<string, TestingTool> = {
  unit_testing: "vitest",
  regression_testing: "vitest",
  api_testing: "vitest",
  solidity_compilation: "forge",
  foundry_unit: "forge",
  foundry_fuzz: "forge",
  invariant_testing: "forge",
  slither_static_analysis: "slither",
};

export function toolLabel(tool: string): string {
  return (TESTING_TOOLS as Record<string, string>)[tool] ?? tool;
}

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Informational",
};

export const FINDING_CATEGORY_LABELS: Record<string, string> = {
  test_failure: "Failing test",
  static_analysis: "Static analysis",
  compiler: "Compiler",
};

export const JOB_STATUS_LABELS = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Could not run",
} as const;

export const OUTCOME_LABELS = {
  passed: "Passed",
  failed: "Failed",
  error: "Could not run",
} as const;

export type ResultFigures = {
  outcome: "passed" | "failed" | "error";
  tool: string;
  testsTotal: number | null;
  testsPassed: number | null;
  testsFailed: number | null;
  testsSkipped: number | null;
  errorMessage?: string | null;
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function countBySeverity(findings: ReadonlyArray<{ severity: Severity }>): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** "1 high, 2 low" — severities with nothing against them are left out. */
export function severityBreakdown(findings: ReadonlyArray<{ severity: Severity }>): string {
  const counts = countBySeverity(findings);
  return SEVERITIES.filter((severity) => counts[severity] > 0)
    .map((severity) => `${counts[severity]} ${SEVERITY_LABELS[severity].toLowerCase()}`)
    .join(", ");
}

/** One sentence stating what a run reported, built only from the stored figures. */
export function describeResult(
  result: ResultFigures,
  findings: ReadonlyArray<{ severity: Severity }>,
): string {
  const tool = toolLabel(result.tool);
  if (result.outcome === "error") {
    return `${tool} could not complete the run${result.errorMessage ? `: ${result.errorMessage}` : "."}`;
  }
  if (result.testsTotal !== null) {
    const parts = [`${result.testsPassed ?? 0} passed`, `${result.testsFailed ?? 0} failed`];
    if (result.testsSkipped) parts.push(`${result.testsSkipped} skipped`);
    return `${tool} ran ${plural(result.testsTotal, "test")}: ${parts.join(", ")}.`;
  }
  if (result.tool === "slither") {
    return findings.length === 0
      ? "Slither analysed the contracts and reported nothing."
      : `Slither reported ${plural(findings.length, "finding")}: ${severityBreakdown(findings)}.`;
  }
  return result.outcome === "passed"
    ? `${tool} compiled the contracts without errors.`
    : `${tool} could not compile the contracts.`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}
