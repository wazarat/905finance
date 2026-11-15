import { readFile } from "node:fs/promises";
import path from "node:path";
import { run } from "../exec.mjs";

const SEVERITY = { High: "high", Medium: "medium", Low: "low", Informational: "info", Optimization: "info" };

/**
 * Turn Slither's JSON report into findings. Severity is Slither's own impact
 * rating for each detector; nothing here re-rates it.
 */
export function parseSlitherReport(report) {
  const detectors = report?.results?.detectors ?? [];
  return detectors.map((detector) => {
    const element = (detector.elements ?? []).find((e) => e?.source_mapping?.filename_relative);
    const mapping = element?.source_mapping;
    const line = Array.isArray(mapping?.lines) && mapping.lines.length > 0 ? `:${mapping.lines[0]}` : "";
    return {
      title: `Slither: ${detector.check ?? "finding"}`,
      severity: SEVERITY[detector.impact] ?? "info",
      category: "static_analysis",
      location: mapping ? `${mapping.filename_relative}${line}` : "",
      span: line ? { start: Math.min(...mapping.lines), end: Math.max(...mapping.lines) } : undefined,
      evidence: [
        String(detector.description ?? "").trim(),
        detector.confidence ? `Slither confidence: ${detector.confidence}` : "",
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 4000),
      recommendation: `Review the code flagged by Slither's "${detector.check ?? "this"}" detector and confirm whether it is exploitable.`,
    };
  });
}

export async function runSlither({ runDir, timeoutMs, toolVersion }) {
  const reportFile = path.join(runDir, ".slither-report.json");
  // Only the contracts under src are analysed; the tests deliberately contain an attacker.
  const args = [".", "--json", reportFile, "--filter-paths", "test/"];
  const result = await run("slither", args, { cwd: runDir, timeoutMs });
  const log = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const base = {
    tool: "slither",
    toolVersion,
    command: "slither . --filter-paths test/",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    log,
  };
  if (result.timedOut || result.spawnError) {
    return {
      ...base,
      outcome: "error",
      error: result.timedOut ? "Static analysis exceeded its time limit and was stopped." : result.spawnError,
      findings: [],
    };
  }
  let report;
  try {
    report = JSON.parse(await readFile(reportFile, "utf8"));
  } catch {
    return { ...base, outcome: "error", error: "Slither produced no report, so no findings can be stated.", findings: [] };
  }
  if (report.success === false) {
    return {
      ...base,
      outcome: "error",
      error: `Slither could not analyse the project: ${String(report.error ?? "unknown error").slice(0, 500)}`,
      findings: [],
    };
  }
  const findings = parseSlitherReport(report);
  const serious = findings.some((f) => f.severity === "high" || f.severity === "medium");
  return { ...base, outcome: serious ? "failed" : "passed", findings };
}
