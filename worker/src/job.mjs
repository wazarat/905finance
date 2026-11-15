import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isShared, planFor } from "./plans.mjs";
import { fetchRepository } from "./repository.mjs";
import { runChaincheck } from "./runners/chaincheck.mjs";
import { runEslintSecurity } from "./runners/eslint-security.mjs";
import { runSolhint } from "./runners/solhint.mjs";
import { runWebcheck } from "./runners/webcheck.mjs";
import { runForgeBuild, runForgeTest } from "./runners/forge.mjs";
import { runSlither } from "./runners/slither.mjs";
import { runVitest } from "./runners/vitest.mjs";
import { prepareEmptyRunDirectory, prepareRunDirectory, removeRunDirectory } from "./workspace.mjs";

const MAX_LOG = 200_000;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_SHARED_BYTES = 600_000;

/** Write the files a buyer shared into the job's private directory. They are only ever read. */
async function writeSharedFiles(runDir, files) {
  let bytes = 0;
  let written = 0;
  for (const file of Array.isArray(files) ? files.slice(0, 20) : []) {
    if (typeof file?.name !== "string" || typeof file?.content !== "string" || !FILE_NAME.test(file.name)) continue;
    bytes += Buffer.byteLength(file.content);
    if (bytes > MAX_SHARED_BYTES) break;
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, file.name), file.content);
    written += 1;
  }
  if (written === 0) throw new Error("The job carried no files that can be read.");
  return written;
}
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
 * @param {{ id: string, fixtureKey: string, capability: string, source?: Record<string, unknown>, files?: Array<{ name: string, content: string }> }} job
 * @param {Record<string, string | null>} tools
 * @param {{ fetchSource?: typeof fetchRepository, runWebcheck?: (input: any) => Promise<any>, runChaincheck?: (input: any) => Promise<any> }} [options] Test hooks: stand in for GitHub, a website, the chain.
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

  const shared = isShared(job.fixtureKey);
  const runDir = shared ? await prepareEmptyRunDirectory(job.id) : await prepareRunDirectory(job.fixtureKey, job.id);
  try {
    let origin = null;
    let provenance = "";
    try {
      if (job.fixtureKey === "github") {
        origin = await (options.fetchSource ?? fetchRepository)(job.source, runDir);
        provenance = `Read github.com/${origin.name}${origin.revision ? ` at commit ${origin.revision}` : ""}: ${origin.files} files. Nothing in it was installed, built or run.\n`;
      } else if (job.fixtureKey === "files") {
        const written = await writeSharedFiles(runDir, job.files);
        provenance = `Read ${written} shared ${written === 1 ? "file" : "files"}. Nothing in ${written === 1 ? "it" : "them"} was run.\n`;
      }
    } catch (error) {
      return {
        outcome: "error",
        tool: plan.tool,
        toolVersion,
        command: "",
        exitCode: null,
        durationMs: 0,
        log: "",
        error: `${job.fixtureKey === "github" ? "The repository could not be fetched" : "The shared files could not be read"}: ${String(error?.message ?? error).slice(0, 300)}`,
        findings: [],
      };
    }
    const input = { runDir, target: plan.target, timeoutMs: plan.timeoutMs, toolVersion, shared, source: job.source };
    const result =
      plan.runner === "vitest"
        ? await runVitest(input)
        : plan.runner === "forge-test"
          ? await runForgeTest(input)
          : plan.runner === "forge-build"
            ? await runForgeBuild(input)
            : plan.runner === "eslint-security"
              ? await runEslintSecurity(input)
              : plan.runner === "solhint"
                ? await runSolhint(input)
                : plan.runner === "webcheck"
                  ? await (options.runWebcheck ?? runWebcheck)(input)
                  : plan.runner === "chaincheck"
                    ? await (options.runChaincheck ?? runChaincheck)(input)
                    : await runSlither(input);
    // Paths inside the private run directory mean nothing to a reader.
    const scrub = (text) => String(text ?? "").replaceAll(runDir, ".");
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
