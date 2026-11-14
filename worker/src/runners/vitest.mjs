import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { run } from "../exec.mjs";

const require = createRequire(import.meta.url);

function vitestEntry() {
  return path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
}

/** The assertion message and the one stack line that points into the project. */
function failureEvidence(text, relativeFile) {
  const lines = String(text ?? "").split("\n");
  const message = lines.filter((line) => !/^\s*at\s/.test(line)).slice(0, 12);
  const frame = lines.find((line) => /^\s*at\s/.test(line) && relativeFile && line.includes(relativeFile));
  return [...message, frame ? frame.trim() : ""].filter((line) => line.trim().length > 0).join("\n").trim();
}

/**
 * Turn Vitest's JSON report into counts and findings. Every number comes from
 * the report; nothing is inferred when the report is missing.
 */
export function parseVitestReport(report, runDir) {
  const findings = [];
  for (const file of report.testResults ?? []) {
    const relative = path.relative(runDir, file.name ?? "");
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status !== "failed") continue;
      const message = failureEvidence((assertion.failureMessages ?? []).join("\n"), relative);
      const line = /:(\d+):\d+\)?\s*$/m.exec(
        (assertion.failureMessages ?? []).join("\n").split("\n").find((l) => l.includes(relative)) ?? "",
      );
      findings.push({
        title: `Failing test: ${assertion.fullName ?? assertion.title ?? "unnamed test"}`,
        severity: "medium",
        category: "test_failure",
        location: line ? `${relative}:${line[1]}` : relative,
        evidence: message.slice(0, 4000),
        recommendation:
          "This test fails against the current code. Review the test and the code it exercises, then fix whichever is wrong.",
      });
    }
    // A file that could not even be loaded reports no assertions of its own.
    if ((file.assertionResults ?? []).length === 0 && file.status === "failed") {
      findings.push({
        title: `Test file could not run: ${relative}`,
        severity: "medium",
        category: "test_failure",
        location: relative,
        evidence: failureEvidence(file.message, relative).slice(0, 4000),
        recommendation: "Fix the error that stops this test file from loading.",
      });
    }
  }
  return {
    testsTotal: report.numTotalTests ?? 0,
    testsPassed: report.numPassedTests ?? 0,
    testsFailed: report.numFailedTests ?? 0,
    testsSkipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
    findings,
  };
}

export async function runVitest({ runDir, target, timeoutMs, toolVersion }) {
  const reportFile = path.join(runDir, ".vitest-report.json");
  // One run, two reporters: the readable output becomes the evidence log and
  // the JSON report is where every count comes from.
  const args = [
    "--max-old-space-size=512",
    vitestEntry(),
    "run",
    target,
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${reportFile}`,
  ];
  const result = await run(process.execPath, args, { cwd: runDir, timeoutMs });
  const command = `vitest run ${target}`;
  const log = [result.stdout, result.stderr].filter(Boolean).join("\n");

  if (result.timedOut || result.spawnError) {
    return {
      outcome: "error",
      tool: "vitest",
      toolVersion,
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      log,
      error: result.timedOut ? "The test run exceeded its time limit and was stopped." : result.spawnError,
      findings: [],
    };
  }

  let report;
  try {
    report = JSON.parse(await readFile(reportFile, "utf8"));
  } catch {
    return {
      outcome: "error",
      tool: "vitest",
      toolVersion,
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      log,
      error: "Vitest produced no report, so no results can be stated.",
      findings: [],
    };
  }

  const parsed = parseVitestReport(report, runDir);
  return {
    outcome: parsed.testsFailed > 0 || parsed.findings.length > 0 ? "failed" : "passed",
    tool: "vitest",
    toolVersion,
    command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    log,
    ...parsed,
  };
}
