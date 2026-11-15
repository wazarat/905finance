import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../exec.mjs";

const require = createRequire(import.meta.url);
const CONFIG = fileURLToPath(new URL("../rules/security.eslint.config.mjs", import.meta.url));

function eslintEntry() {
  return path.join(path.dirname(require.resolve("eslint/package.json")), "bin", "eslint.js");
}

/**
 * What each rule means, in words a reader can act on. The severity is this
 * worker's rating of the weakness class; whether a rule fired, and where, is
 * ESLint's alone.
 */
const RULES = {
  "security/detect-eval-with-expression": {
    title: "Code injection: eval() runs text built at run time",
    severity: "high",
    recommendation:
      "Do not evaluate text as code. Parse the input into data and apply fixed logic to it, so that nothing a user or merchant supplies can execute.",
  },
  "security/detect-child-process": {
    title: "Command injection: a shell command is built at run time",
    severity: "high",
    recommendation: "Call the program with a fixed command and an argument list, never a command line assembled from input.",
  },
  "security/detect-non-literal-require": {
    title: "Code loading: a module path is chosen at run time",
    severity: "high",
    recommendation: "Load modules by fixed names. If a choice is needed, look it up in a fixed table of allowed modules.",
  },
  "security/detect-non-literal-fs-filename": {
    title: "Path traversal: a file path is built from input",
    severity: "medium",
    recommendation:
      "Resolve the path, then confirm it is still inside the intended directory before opening it, or look the file up by a validated identifier.",
  },
  "security/detect-non-literal-regexp": {
    title: "Regular expression injection: a pattern is built from input",
    severity: "medium",
    recommendation:
      "Escape the input before using it in a pattern, or match it as plain text. An attacker-chosen pattern can also be made slow enough to stall the service.",
  },
  "security/detect-unsafe-regex": {
    title: "Denial of service: a regular expression can backtrack without limit",
    severity: "medium",
    recommendation: "Rewrite the pattern without nested repetition, or bound the length of what it is applied to.",
  },
  "security/detect-possible-timing-attacks": {
    title: "Timing attack: a secret is compared with ===",
    severity: "medium",
    recommendation:
      "Compare secrets with a constant-time function such as crypto.timingSafeEqual, so the time taken does not reveal how much of a guess was right.",
  },
  "security/detect-pseudoRandomBytes": {
    title: "Weak randomness: pseudoRandomBytes is not cryptographically secure",
    severity: "medium",
    recommendation: "Use crypto.randomBytes for anything a secret or token depends on.",
  },
  "security/detect-bidi-characters": {
    title: "Hidden text: the source contains bidirectional control characters",
    severity: "high",
    recommendation: "Remove the control characters. They can make code read differently from how it runs.",
  },
  "security/detect-no-csrf-before-method-override": {
    title: "CSRF protection can be bypassed by method override",
    severity: "medium",
    recommendation: "Apply method override before the CSRF check, not after it.",
  },
  "security/detect-disable-mustache-escape": {
    title: "Cross-site scripting: output escaping is switched off",
    severity: "medium",
    recommendation: "Leave template escaping on, and mark only reviewed values as safe.",
  },
  "security/detect-new-buffer": {
    title: "Unsafe buffer: new Buffer() with a run-time size or value",
    severity: "low",
    recommendation: "Use Buffer.from or Buffer.alloc.",
  },
  "security/detect-buffer-noassert": {
    title: "Unchecked buffer access: bounds checks are switched off",
    severity: "low",
    recommendation: "Remove the noAssert flag so that out-of-range reads and writes are rejected.",
  },
  "security/detect-object-injection": {
    title: "Property injection: an object is indexed by a run-time key",
    severity: "low",
    recommendation: "Confirm the key is one of a fixed set, or use a Map, so that input cannot reach inherited properties.",
  },
};

const RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const MAX_FINDINGS = 200;

/** Turn ESLint's JSON report into findings. Which rules fired, and where, comes from the report alone. */
export function parseEslintReport(report, runDir) {
  const findings = [];
  for (const file of report ?? []) {
    const relative = path.relative(runDir, file.filePath ?? "");
    for (const message of file.messages ?? []) {
      const known = RULES[message.ruleId];
      const start = Number.isInteger(message.line) ? message.line : null;
      const end = Number.isInteger(message.endLine) ? message.endLine : start;
      findings.push({
        title: message.fatal
          ? `File could not be analysed: ${relative}`
          : (known?.title ?? `Security rule: ${String(message.ruleId ?? "unnamed").replace(/^security\//, "")}`),
        severity: message.fatal ? "info" : (known?.severity ?? "low"),
        category: message.fatal ? "compiler" : "security",
        location: start ? `${relative}:${start}` : relative,
        span: start ? { start, end } : undefined,
        evidence: [String(message.message ?? "").trim(), message.ruleId ? `ESLint rule: ${message.ruleId}` : ""]
          .filter(Boolean)
          .join("\n")
          .slice(0, 4000),
        recommendation: message.fatal
          ? "Fix the syntax error so that this file can be analysed."
          : (known?.recommendation ?? "Review the flagged code and confirm whether input can reach it."),
      });
    }
  }
  return findings;
}

export async function runEslintSecurity({ runDir, target, timeoutMs, toolVersion }) {
  const args = [
    eslintEntry(),
    "--no-config-lookup",
    "--no-inline-config",
    "--config",
    CONFIG,
    "--format",
    "json",
    target ?? ".",
  ];
  const result = await run(process.execPath, args, { cwd: runDir, timeoutMs, maxStdoutBytes: 4_000_000 });
  const base = {
    tool: "eslint",
    toolVersion,
    command: `eslint --no-inline-config --config security-rules ${target ?? "."}`,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    log: result.stderr,
  };
  if (result.timedOut || result.spawnError) {
    return {
      ...base,
      outcome: "error",
      error: result.timedOut ? "The security scan exceeded its time limit and was stopped." : result.spawnError,
      findings: [],
    };
  }
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = null;
  }
  // Exit code 2 is ESLint's own failure, as opposed to 1, which means rules fired.
  if (!Array.isArray(report) || result.exitCode === 2) {
    return {
      ...base,
      outcome: "error",
      error: `ESLint could not analyse the project${result.stderr ? `: ${result.stderr.trim().slice(0, 400)}` : "."}`,
      findings: [],
    };
  }
  if (report.length === 0) {
    return {
      ...base,
      outcome: "error",
      error: "There is no JavaScript or TypeScript source here for the security scan to read.",
      findings: [],
    };
  }
  // ESLint names files by their real path, which differs from runDir where a parent is a link.
  const every = parseEslintReport(report, await realpath(runDir).catch(() => runDir));
  // The most serious first, so that a long report is cut from the bottom.
  const findings = every
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => RANK[a.finding.severity] - RANK[b.finding.severity] || a.index - b.index)
    .map((entry) => entry.finding)
    .slice(0, MAX_FINDINGS);
  const serious = every.some((f) => f.severity === "critical" || f.severity === "high" || f.severity === "medium");
  return {
    ...base,
    log: [
      `Analysed ${report.length} ${report.length === 1 ? "file" : "files"}.`,
      every.length > findings.length
        ? `${every.length} findings in all. The ${findings.length} most serious are listed; ${every.length - findings.length} less serious ones are not.`
        : "",
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
    outcome: serious ? "failed" : "passed",
    findings,
  };
}
