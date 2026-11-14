import { planFor } from "./plans.mjs";
import { runForgeBuild, runForgeTest } from "./runners/forge.mjs";
import { runSlither } from "./runners/slither.mjs";
import { runVitest } from "./runners/vitest.mjs";
import { prepareRunDirectory, removeRunDirectory } from "./workspace.mjs";

const MAX_LOG = 200_000;

/**
 * Execute one job and return its result. The job only says which fixture and
 * which capability; what is run is decided by this worker's own table.
 *
 * @param {{ id: string, fixtureKey: string, capability: string }} job
 * @param {Record<string, string | null>} tools
 */
export async function executeJob(job, tools) {
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

  const runDir = await prepareRunDirectory(job.fixtureKey, job.id);
  try {
    const input = { runDir, target: plan.target, timeoutMs: plan.timeoutMs, toolVersion };
    const result =
      plan.runner === "vitest"
        ? await runVitest(input)
        : plan.runner === "forge-test"
          ? await runForgeTest(input)
          : plan.runner === "forge-build"
            ? await runForgeBuild(input)
            : await runSlither(input);
    // Paths inside the private run directory mean nothing to a reader.
    const scrub = (text) => String(text ?? "").replaceAll(runDir, ".");
    return {
      ...result,
      log: scrub(result.log).slice(0, MAX_LOG),
      error: result.error ? scrub(result.error) : undefined,
      findings: (result.findings ?? []).slice(0, 200).map((finding) => ({
        ...finding,
        evidence: scrub(finding.evidence),
        location: scrub(finding.location),
      })),
    };
  } finally {
    await removeRunDirectory(runDir);
  }
}
