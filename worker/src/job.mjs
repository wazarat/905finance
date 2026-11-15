import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { REPOSITORY, planFor } from "./plans.mjs";
import { fetchRepository } from "./repository.mjs";
import { runEslintSecurity } from "./runners/eslint-security.mjs";
import { runForgeBuild, runForgeTest } from "./runners/forge.mjs";
import { runSlither } from "./runners/slither.mjs";
import { runVitest } from "./runners/vitest.mjs";
import { prepareEmptyRunDirectory, prepareRunDirectory, removeRunDirectory } from "./workspace.mjs";

const MAX_LOG = 200_000;
const CONTEXT_LINES = 3;
const MAX_EXCERPT_LINES = 40;
const MAX_LINE_LENGTH = 240;

/**
 * The lines of source a finding points at, with a little around them, read
 * from the job's own copy of the project. Returns nothing rather than guess:
 * a location that is not a readable file inside the run directory, or a line
 * past the end of it, gets no excerpt.
 */
async function excerptFor(runDir, finding) {
  const match = /^(.+?):(\d+)$/.exec(finding.location ?? "");
  if (!match) return undefined;
  const file = path.resolve(runDir, match[1]);
  if (!file.startsWith(runDir + path.sep)) return undefined;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 1_000_000) return undefined;
    const source = (await readFile(file, "utf8")).split("\n");
    if (source.at(-1) === "") source.pop();
    const first = finding.span?.start ?? Number(match[2]);
    const last = Math.max(first, Math.min(finding.span?.end ?? first, first + MAX_EXCERPT_LINES - 2 * CONTEXT_LINES - 1));
    if (!Number.isInteger(first) || first < 1 || first > source.length) return undefined;
    const from = Math.max(1, first - CONTEXT_LINES);
    const to = Math.min(source.length, last + CONTEXT_LINES);
    return {
      file: match[1],
      startLine: from,
      highlightStart: first,
      highlightEnd: Math.min(last, source.length),
      lines: source.slice(from - 1, to).map((line) => line.replace(/\r$/, "").slice(0, MAX_LINE_LENGTH)),
    };
  } catch {
    return undefined;
  }
}

/**
 * Execute one job and return its result. The job only says which fixture and
 * which capability; what is run is decided by this worker's own table.
 *
 * @param {{ id: string, fixtureKey: string, capability: string, source?: { kind: string, owner: string, repo: string } }} job
 * @param {Record<string, string | null>} tools
 * @param {{ fetchSource?: typeof fetchRepository }} [options] Test hook: stand in for GitHub.
 */
export async function executeJob(job, tools, options = {}) {
  const plan = planFor(job.fixtureKey, job.capability);
  if (!plan) {
    return {
      outcome: "error",
      tool: "none",
      toolVersion: "",
      command: "",
      exitCode: null,
      durationMs: 0,
      log: "",
      error: "This worker has no way to run that test type against that project.",
      findings: [],
    };
  }
  const toolVersion = tools[plan.tool];
  if (!toolVersion) {
    return {
      outcome: "error",
      tool: plan.tool,
      toolVersion: "",
      command: "",
      exitCode: null,
      durationMs: 0,
      log: "",
      error: `${plan.tool} is not installed in this worker.`,
      findings: [],
    };
  }

  const shared = job.fixtureKey === REPOSITORY;
  const runDir = shared ? await prepareEmptyRunDirectory(job.id) : await prepareRunDirectory(job.fixtureKey, job.id);
  try {
    let origin = null;
    if (shared) {
      try {
        origin = await (options.fetchSource ?? fetchRepository)(job.source, runDir);
      } catch (error) {
        return {
          outcome: "error",
          tool: plan.tool,
          toolVersion,
          command: "",
          exitCode: null,
          durationMs: 0,
          log: "",
          error: `The repository could not be fetched: ${String(error?.message ?? error).slice(0, 300)}`,
          findings: [],
        };
      }
    }
    const input = { runDir, target: plan.target, timeoutMs: plan.timeoutMs, toolVersion, shared };
    const result =
      plan.runner === "vitest"
        ? await runVitest(input)
        : plan.runner === "forge-test"
          ? await runForgeTest(input)
          : plan.runner === "forge-build"
            ? await runForgeBuild(input)
            : plan.runner === "eslint-security"
              ? await runEslintSecurity(input)
              : await runSlither(input);
    // Paths inside the private run directory mean nothing to a reader.
    const scrub = (text) => String(text ?? "").replaceAll(runDir, ".");
    // What was read, and at which commit, is part of the record of the run.
    const provenance = origin
      ? `Read github.com/${origin.name}${origin.revision ? ` at commit ${origin.revision}` : ""}: ${origin.files} files. Nothing in it was installed, built or run.\n`
      : "";
    return {
      ...result,
      log: (provenance + scrub(result.log)).slice(0, MAX_LOG),
      error: result.error ? scrub(result.error) : undefined,
      findings: await Promise.all(
        (result.findings ?? []).slice(0, 200).map(async ({ span, ...finding }) => {
          const location = scrub(finding.location);
          const code = await excerptFor(runDir, { location, span });
          return { ...finding, evidence: scrub(finding.evidence), location, ...(code ? { code } : {}) };
        }),
      ),
    };
  } finally {
    await removeRunDirectory(runDir);
  }
}
