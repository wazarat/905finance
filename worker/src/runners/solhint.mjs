import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../exec.mjs";

const require = createRequire(import.meta.url);
const RULES_FILE = fileURLToPath(new URL("../rules/solidity-security.solhint.json", import.meta.url));

function solhintEntry() {
  return path.join(path.dirname(require.resolve("solhint/package.json")), "solhint.js");
}

/**
 * What each rule means. Solhint reads Solidity without compiling it, so it
 * recognises risky constructs by their shape. It is a first look, not an
 * audit: it cannot follow value through a contract the way a compiler-based
 * analyser can. The severity is this worker's rating of the construct;
 * whether a rule fired, and where, is Solhint's alone.
 */
const RULES = {
  reentrancy: {
    title: "Possible reentrancy: state changes after funds are sent",
    severity: "high",
    recommendation: "Update balances and other state before sending funds, or guard the function against re-entry.",
  },
  "avoid-tx-origin": {
    title: "Authorization by tx.origin",
    severity: "high",
    recommendation: "Use msg.sender. A contract the user calls can pass a tx.origin check on the user's behalf.",
  },
  "avoid-suicide": {
    title: "The contract can destroy itself",
    severity: "high",
    recommendation: "Remove selfdestruct, or make certain only the intended party can ever reach it.",
  },
  "avoid-low-level-calls": {
    title: "Low-level call",
    severity: "medium",
    recommendation: "Call the target through its interface, or check the call's result and limit what it can reach.",
  },
  "avoid-call-value": {
    title: "Funds sent with call.value",
    severity: "medium",
    recommendation: "Check the result, and make state changes before the call so a callback cannot exploit them.",
  },
  "check-send-result": {
    title: "The result of send is not checked",
    severity: "medium",
    recommendation: "Check what send returns. It reports failure by returning false, not by reverting.",
  },
  "multiple-sends": {
    title: "Several sends in one transaction",
    severity: "medium",
    recommendation: "Let each recipient withdraw their own funds, so one failing transfer cannot block the others.",
  },
  "not-rely-on-block-hash": {
    title: "Logic depends on a block hash",
    severity: "medium",
    recommendation: "A block hash can be influenced by whoever produces the block. Do not use it for randomness.",
  },
  "func-visibility": {
    title: "A function has no explicit visibility",
    severity: "medium",
    recommendation: "State whether the function is public, external, internal or private.",
  },
  "not-rely-on-time": {
    title: "Logic depends on the block timestamp",
    severity: "low",
    recommendation: "Block times can be nudged by block producers. Do not rely on them for anything a few seconds could change.",
  },
  "no-inline-assembly": {
    title: "Inline assembly",
    severity: "low",
    recommendation: "Assembly bypasses Solidity's safety checks. Keep it small, and review it line by line.",
  },
  "no-complex-fallback": {
    title: "The fallback function does a lot",
    severity: "low",
    recommendation: "Keep the fallback minimal. It runs on plain transfers, with very little gas.",
  },
  "state-visibility": {
    title: "A state variable has no explicit visibility",
    severity: "low",
    recommendation: "State whether the variable is public, internal or private.",
  },
  "compiler-version": {
    title: "Compiler version is old or not pinned as expected",
    severity: "low",
    recommendation: "Build with a current 0.8 compiler, which checks arithmetic for overflow.",
  },
  "avoid-throw": {
    title: "throw is used",
    severity: "low",
    recommendation: "Use revert, require or assert.",
  },
  "avoid-sha3": {
    title: "sha3 is used",
    severity: "info",
    recommendation: "Use keccak256.",
  },
};

/** Directories that hold code a project depends on or generated, not code it wrote. */
const SKIP = new Set(["node_modules", "npm", "lib", "out", "cache", "artifacts", "dist", "build", ".git", "typechain", "typechain-types"]);
const isVendored = (name) => SKIP.has(name) || name.startsWith("@");
const MAX_FILES = 1_500;
const RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const MAX_FINDINGS = 200;

/** Every Solidity file under `root` that a project wrote itself, relative to `root`. */
export async function solidityFiles(root) {
  const found = [];
  const pending = [""];
  while (pending.length > 0 && found.length < MAX_FILES) {
    const relative = pending.pop();
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (!isVendored(entry.name)) pending.push(next);
      } else if (entry.isFile()) {
        if (/^\.solhint/.test(entry.name)) {
          // The project's own linter settings must not decide what is reported.
          await rm(path.join(root, next), { force: true });
        } else if (entry.name.endsWith(".sol")) {
          found.push(next);
        }
      }
    }
  }
  return found.sort();
}

/**
 * Solhint has no switch to ignore a file's own "solhint-disable" comments, so
 * in this private copy they are rewritten to something it does not recognise.
 * The replacement is the same length: no line or column moves.
 */
async function neutraliseInlineSwitches(root, files) {
  for (const file of files) {
    const full = path.join(root, file);
    const text = await readFile(full, "utf8");
    if (text.includes("solhint-")) await writeFile(full, text.replaceAll("solhint-", "solhint_"));
  }
}

/** Turn Solhint's JSON output into findings. Which rules fired, and where, comes from it alone. */
export function parseSolhintReport(report) {
  const findings = [];
  for (const message of report ?? []) {
    if (!message || typeof message.filePath !== "string") continue;
    const known = RULES[message.ruleId];
    const unread = !message.ruleId;
    const line = Number.isInteger(message.line) ? message.line : null;
    findings.push({
      title: unread
        ? `File could not be read as Solidity: ${message.filePath}`
        : (known?.title ?? `Solidity rule: ${message.ruleId}`),
      severity: unread ? "info" : (known?.severity ?? "low"),
      category: unread ? "compiler" : "security",
      location: line ? `${message.filePath}:${line}` : message.filePath,
      evidence: [String(message.message ?? "").trim(), message.ruleId ? `Solhint rule: ${message.ruleId}` : ""]
        .filter(Boolean)
        .join("\n")
        .slice(0, 4000),
      recommendation: unread
        ? "Fix the syntax so that this file can be reviewed."
        : (known?.recommendation ?? "Review the flagged code."),
    });
  }
  return findings;
}

/**
 * Lint the Solidity under `runDir/target`. Returns the findings and how many
 * files were read, or an error.
 */
export async function lintSolidity({ runDir, target, timeoutMs }) {
  const root = path.join(runDir, target ?? ".");
  const files = await solidityFiles(root);
  if (files.length === 0) return { files: 0, findings: [], exitCode: null, durationMs: 0, stderr: "" };
  await neutraliseInlineSwitches(root, files);
  const every = [];
  let exitCode = 0;
  let durationMs = 0;
  const stderr = "";
  /** Lint some files in one run of Solhint. Null when it produced no report, as it does when a file breaks its parser. */
  const lint = async (batch) => {
    const result = await run(
      process.execPath,
      [solhintEntry(), "-c", RULES_FILE, "-f", "json", "--noPoster", "--disc", ...batch],
      { cwd: root, timeoutMs, maxStdoutBytes: 4_000_000 },
    );
    durationMs += result.durationMs;
    if (result.timedOut) throw new Error("The Solidity review exceeded its time limit and was stopped.");
    if (result.spawnError) throw new Error(result.spawnError);
    try {
      const report = JSON.parse(result.stdout);
      if (!Array.isArray(report)) return null;
      exitCode = Math.max(exitCode, result.exitCode ?? 0);
      return parseSolhintReport(report);
    } catch {
      return null;
    }
  };
  try {
    for (let start = 0; start < files.length; start += 200) {
      const batch = files.slice(start, start + 200);
      const together = await lint(batch);
      if (together) {
        every.push(...together);
        continue;
      }
      // One file broke the run. Take them one at a time, and say which could not be read.
      for (const file of batch) {
        const alone = await lint([file]);
        if (alone) every.push(...alone);
        else {
          every.push({
            title: `File could not be read as Solidity: ${file}`,
            severity: "info",
            category: "compiler",
            location: file,
            evidence: "Solhint could not parse this file.",
            recommendation: "Check the file's syntax. Nothing in it was reviewed.",
          });
        }
      }
    }
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
  // Paths are reported relative to the target; findings name them from the run directory.
  const prefix = target && target !== "." ? `${target}/` : "";
  const findings = every.map((finding) => ({ ...finding, location: prefix + finding.location }));
  return { files: files.length, findings, exitCode, durationMs, stderr };
}

export async function runSolhint({ runDir, target, timeoutMs, toolVersion }) {
  const result = await lintSolidity({ runDir, target, timeoutMs });
  const base = {
    tool: "solhint",
    toolVersion,
    command: "solhint --config security-rules **/*.sol",
    exitCode: result.exitCode ?? null,
    durationMs: result.durationMs ?? 0,
    log: "",
  };
  if (result.error) return { ...base, outcome: "error", error: result.error, findings: [] };
  if (result.files === 0) {
    return { ...base, outcome: "error", error: "There is no Solidity source here for the review to read.", findings: [] };
  }
  const every = result.findings;
  const findings = every
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => RANK[a.finding.severity] - RANK[b.finding.severity] || a.index - b.index)
    .map((entry) => entry.finding)
    .slice(0, MAX_FINDINGS);
  const serious = every.some((f) => f.severity === "critical" || f.severity === "high" || f.severity === "medium");
  return {
    ...base,
    log: [
      `Reviewed ${result.files} Solidity ${result.files === 1 ? "file" : "files"} without compiling ${result.files === 1 ? "it" : "them"}.`,
      "This is a pattern review: it recognises risky constructs by their shape and does not follow value through the contract.",
      every.length > findings.length
        ? `${every.length} findings in all. The ${findings.length} most serious are listed.`
        : "",
      result.stderr,
    ]
      .filter(Boolean)
      .join("\n"),
    outcome: serious ? "failed" : "passed",
    findings,
  };
}
