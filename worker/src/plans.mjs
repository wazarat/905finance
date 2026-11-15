/**
 * What this worker is able to run.
 *
 * A job names a fixture and a capability and nothing else. The command that
 * is executed comes from this table, never from the job, so the application
 * cannot ask the worker to run anything that is not listed here.
 */

/** @typedef {"vitest" | "forge" | "slither"} Tool */
/** @typedef {{ tool: Tool, runner: "vitest" | "forge-build" | "forge-test" | "slither", target?: string, timeoutMs: number }} Plan */

/** @type {Record<string, Record<string, Plan>>} */
export const PLANS = {
  "sample-node-api": {
    unit_testing: { tool: "vitest", runner: "vitest", target: "tests/unit", timeoutMs: 120_000 },
    regression_testing: { tool: "vitest", runner: "vitest", target: "tests/regression", timeoutMs: 120_000 },
    api_testing: { tool: "vitest", runner: "vitest", target: "tests/api", timeoutMs: 120_000 },
    security_scan: { tool: "eslint", runner: "eslint-security", target: "src", timeoutMs: 120_000 },
  },
  "sample-solidity-vault": {
    solidity_compilation: { tool: "forge", runner: "forge-build", timeoutMs: 180_000 },
    foundry_unit: { tool: "forge", runner: "forge-test", target: "test/unit/*", timeoutMs: 180_000 },
    foundry_fuzz: { tool: "forge", runner: "forge-test", target: "test/fuzz/*", timeoutMs: 240_000 },
    invariant_testing: { tool: "forge", runner: "forge-test", target: "test/invariant/*", timeoutMs: 300_000 },
    slither_static_analysis: { tool: "slither", runner: "slither", timeoutMs: 240_000 },
  },
};

/** @returns {Plan | null} */
/**
 * What may be done to a repository someone shared. Only tools that read code
 * are here: nothing in a shared repository is ever installed, built or run.
 */
export const REPOSITORY = "github";
export const REPOSITORY_PLANS = {
  security_scan: { tool: "eslint", runner: "eslint-security", target: ".", timeoutMs: 240_000 },
};

export function planFor(fixtureKey, capability) {
  if (fixtureKey === REPOSITORY) {
    return Object.hasOwn(REPOSITORY_PLANS, capability) ? REPOSITORY_PLANS[capability] : null;
  }
  if (!Object.hasOwn(PLANS, fixtureKey)) return null;
  const forFixture = PLANS[fixtureKey];
  return Object.hasOwn(forFixture, capability) ? forFixture[capability] : null;
}

/**
 * The "fixture:capability" pairs this worker can run, given which tools are
 * installed. Reported to the application so it only accepts work that can be done.
 * @param {Partial<Record<Tool, string | null>>} tools
 */
export function supportedPairs(tools) {
  const pairs = [];
  for (const [fixtureKey, capabilities] of Object.entries(PLANS)) {
    for (const [capability, plan] of Object.entries(capabilities)) {
      if (tools[plan.tool]) pairs.push(`${fixtureKey}:${capability}`);
    }
  }
  for (const [capability, plan] of Object.entries(REPOSITORY_PLANS)) {
    if (tools[plan.tool]) pairs.push(`${REPOSITORY}:${capability}`);
  }
  return pairs;
}
