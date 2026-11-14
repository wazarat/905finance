import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the bundled fixtures live. They ship with the worker, not with a job. */
export function fixturesDir() {
  return path.resolve(process.env.FIXTURES_DIR ?? path.join(workerRoot, "..", "fixtures"));
}

const SKIP = new Set(["node_modules", "out", "cache", ".git"]);

/**
 * A fresh private copy of a fixture for one job, under the worker's run
 * directory. Each job gets its own copy and it is deleted afterwards, so one
 * job can never see or alter another's files.
 */
export async function prepareRunDirectory(fixtureKey, jobId) {
  // The key has already been checked against the table of known fixtures.
  const source = path.join(fixturesDir(), fixtureKey);
  if (!existsSync(source)) throw new Error(`Fixture "${fixtureKey}" is not installed in this worker.`);
  const safeId = String(jobId).replace(/[^a-zA-Z0-9-]/g, "");
  const runDir = path.join(workerRoot, ".runs", `${safeId}-${Date.now()}`);
  await mkdir(runDir, { recursive: true });
  await cp(source, runDir, {
    recursive: true,
    filter: (entry) => !SKIP.has(path.basename(entry)),
  });
  return runDir;
}

export async function removeRunDirectory(runDir) {
  await rm(runDir, { recursive: true, force: true });
}
