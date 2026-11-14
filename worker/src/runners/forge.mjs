import { run } from "../exec.mjs";

/** "1s 607ms 321µs 250ns" -> milliseconds. */
export function parseForgeDuration(text) {
  let ms = 0;
  for (const [, value, unit] of String(text ?? "").matchAll(/([\d.]+)\s*(ns|µs|us|ms|s|m)\b/g)) {
    const n = Number(value);
    ms += unit === "m" ? n * 60_000 : unit === "s" ? n * 1000 : unit === "ms" ? n : unit === "ns" ? n / 1e6 : n / 1000;
  }
  return Math.round(ms);
}

function describeCall(call) {
  if (call && typeof call === "object") {
    const name = call.signature ?? call.func_name;
    if (name) return `${String(name).replace(/\(.*$/, "")}(${call.args ?? ""})`;
    if (call.calldata) return `calldata ${call.calldata}`;
  }
  return "";
}

/** A readable form of the input Foundry found that breaks the property. */
export function describeCounterexample(counterexample) {
  if (!counterexample || typeof counterexample !== "object") return "";
  if (counterexample.Single) {
    const single = counterexample.Single;
    const call = describeCall(single);
    return `Counterexample: ${single.args !== undefined && single.args !== null ? `args [${single.args}]` : call}`;
  }
  if (Array.isArray(counterexample.Sequence)) {
    const calls = Array.isArray(counterexample.Sequence[1]) ? counterexample.Sequence[1] : counterexample.Sequence;
    const steps = calls.filter((c) => c && typeof c === "object").map(describeCall).filter(Boolean);
    return `Counterexample sequence:\n${steps.map((step, i) => `  ${i + 1}. ${step}`).join("\n")}`;
  }
  return "";
}

function kindOf(test) {
  const kind = test.kind && typeof test.kind === "object" ? Object.keys(test.kind)[0] : "";
  return kind === "Fuzz" ? "fuzz" : kind === "Invariant" ? "invariant" : "unit";
}

/**
 * Turn `forge test --json` output into counts and findings. A failing fuzz or
 * invariant test is a property Foundry disproved with a concrete input, so it
 * is rated higher than a failing unit test.
 */
export function parseForgeTestReport(report) {
  let testsTotal = 0;
  let testsPassed = 0;
  let testsFailed = 0;
  let testsSkipped = 0;
  const findings = [];

  for (const [suite, suiteResult] of Object.entries(report ?? {})) {
    const file = suite.split(":")[0];
    for (const [name, test] of Object.entries(suiteResult?.test_results ?? {})) {
      testsTotal += 1;
      if (test.status === "Success") testsPassed += 1;
      else if (test.status === "Skipped") testsSkipped += 1;
      else {
        testsFailed += 1;
        const kind = kindOf(test);
        const counterexample = describeCounterexample(test.counterexample);
        findings.push({
          title:
            kind === "invariant"
              ? `Invariant violated: ${name}`
              : kind === "fuzz"
                ? `Property fails under fuzzing: ${name}`
                : `Failing test: ${name}`,
          severity: kind === "unit" ? "medium" : "high",
          category: "test_failure",
          location: file,
          evidence: [test.reason ? `Reason: ${test.reason}` : "", counterexample].filter(Boolean).join("\n").slice(0, 4000),
          recommendation:
            kind === "unit"
              ? "This test fails against the current contract. Review the test and the code it exercises."
              : "Foundry found an input that breaks this property. Reproduce it with the counterexample above and fix the contract.",
        });
      }
    }
  }
  return { testsTotal, testsPassed, testsFailed, testsSkipped, findings };
}

function lastJsonObject(stdout) {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/**
 * A readable transcript of a forge JSON report. It is written from the same
 * report the counts come from, so the log and the numbers cannot disagree.
 */
export function transcribeForgeReport(report) {
  const lines = ["# Transcribed from the report produced by `forge test --json`.", ""];
  for (const [suite, suiteResult] of Object.entries(report ?? {})) {
    const tests = Object.entries(suiteResult?.test_results ?? {});
    lines.push(`Ran ${tests.length} ${tests.length === 1 ? "test" : "tests"} for ${suite}`);
    let passed = 0;
    let failed = 0;
    for (const [name, test] of tests) {
      const kind = test.kind && typeof test.kind === "object" ? test.kind[Object.keys(test.kind)[0]] : null;
      const detail =
        kind && typeof kind === "object"
          ? kind.gas !== undefined
            ? ` (gas: ${kind.gas})`
            : kind.runs !== undefined
              ? ` (runs: ${kind.runs})`
              : ""
          : "";
      if (test.status === "Success") {
        passed += 1;
        lines.push(`[PASS] ${name}${detail}`);
      } else if (test.status === "Skipped") {
        lines.push(`[SKIP] ${name}`);
      } else {
        failed += 1;
        lines.push(`[FAIL: ${test.reason ?? "no reason given"}] ${name}${detail}`);
        const counterexample = describeCounterexample(test.counterexample);
        if (counterexample) lines.push(...counterexample.split("\n").map((line) => `    ${line}`));
      }
    }
    lines.push(
      `Suite result: ${failed > 0 ? "FAILED" : "ok"}. ${passed} passed; ${failed} failed; finished in ${suiteResult?.duration ?? "?"}`,
      "",
    );
  }
  return lines.join("\n").trim();
}

export async function runForgeTest({ runDir, target, timeoutMs, toolVersion }) {
  const args = ["test", "--json", "--match-path", target];
  // The JSON report of an invariant campaign can be large; it is parsed, not stored.
  const result = await run("forge", args, { cwd: runDir, timeoutMs, maxStdoutBytes: 64_000_000 });
  const command = `forge test --match-path "${target}"`;
  const base = { tool: "forge", toolVersion, command, exitCode: result.exitCode, durationMs: result.durationMs };

  if (result.timedOut || result.spawnError) {
    return {
      ...base,
      outcome: "error",
      log: result.stderr,
      error: result.timedOut ? "The test run exceeded its time limit and was stopped." : result.spawnError,
      findings: [],
    };
  }
  const report = lastJsonObject(result.stdout);
  if (!report) {
    // No report means compilation failed or forge could not start the tests.
    return {
      ...base,
      outcome: "error",
      log: [result.stdout.slice(0, 100_000), result.stderr].filter(Boolean).join("\n"),
      error: "Foundry produced no test report. See the log for the compiler or runner error.",
      findings: [],
    };
  }

  const parsed = parseForgeTestReport(report);
  return {
    ...base,
    outcome: parsed.testsFailed > 0 ? "failed" : "passed",
    log: [transcribeForgeReport(report), result.stderr.trim()].filter(Boolean).join("\n\n"),
    ...parsed,
  };
}

export async function runForgeBuild({ runDir, timeoutMs, toolVersion }) {
  const result = await run("forge", ["build", "--force"], { cwd: runDir, timeoutMs });
  const log = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const base = {
    tool: "forge",
    toolVersion,
    command: "forge build --force",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    log,
  };
  if (result.timedOut || result.spawnError) {
    return {
      ...base,
      outcome: "error",
      error: result.timedOut ? "Compilation exceeded its time limit and was stopped." : result.spawnError,
      findings: [],
    };
  }
  if (result.exitCode === 0) return { ...base, outcome: "passed", findings: [] };
  return {
    ...base,
    outcome: "failed",
    findings: [
      {
        title: "Compilation failed",
        severity: "high",
        category: "compiler",
        location: "",
        evidence: log.slice(0, 4000),
        recommendation: "Fix the compiler errors shown in the evidence.",
      },
    ],
  };
}
