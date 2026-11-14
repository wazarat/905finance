import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { executeJob } from "./job.mjs";
import { supportedPairs } from "./plans.mjs";
import { detectTools } from "./tools.mjs";

/**
 * The testing worker.
 *
 * It asks the application for a job, runs it in a private copy of a bundled
 * fixture, and posts the result back. That is its whole relationship with the
 * platform: it holds one credential, its own worker token, and has no access
 * to the database, to sessions, or to any wallet or signing key.
 */

const FORBIDDEN = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "SESSION_SECRET",
  "PRIVY_APP_SECRET",
  "POSTGRES_URL",
  "POSTGRES_PASSWORD",
];

function configuration() {
  const present = FORBIDDEN.filter((key) => process.env[key]);
  if (present.length > 0) {
    throw new Error(
      `The testing worker must not be given platform secrets. Remove: ${present.join(", ")}.`,
    );
  }
  const appUrl = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  const token = process.env.WORKER_TOKEN ?? "";
  if (!/^https?:\/\//.test(appUrl)) throw new Error("APP_URL must be the application's http(s) address.");
  if (token.length < 32) throw new Error("WORKER_TOKEN must be set to the application's worker token.");
  return {
    appUrl,
    token,
    workerId: process.env.WORKER_ID ?? `${hostname()}-${randomBytes(3).toString("hex")}`,
    pollMs: Math.max(Number(process.env.POLL_MS ?? 3000) || 3000, 500),
  };
}

async function post(config, path, body) {
  const response = await fetch(`${config.appUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const config = configuration();
  const drain = process.argv.includes("--drain");
  const tools = await detectTools();
  const supports = supportedPairs(tools);
  console.log(`Worker ${config.workerId} ready.`);
  for (const [tool, version] of Object.entries(tools)) {
    console.log(`  ${tool}: ${version ?? "not installed"}`);
  }

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stopping = true;
    });
  }

  while (!stopping) {
    let job = null;
    try {
      ({ job } = await post(config, "/api/worker/claim", { workerId: config.workerId, tools, supports }));
    } catch (error) {
      console.error(`Could not reach the application: ${error.message}`);
      if (drain) process.exit(1);
      await sleep(config.pollMs * 2);
      continue;
    }
    if (!job) {
      if (drain) break;
      await sleep(config.pollMs);
      continue;
    }

    console.log(`Job ${job.id}: ${job.capability} on ${job.fixtureKey}`);
    let result;
    try {
      result = await executeJob(job, tools);
    } catch (error) {
      result = {
        outcome: "error",
        tool: "none",
        toolVersion: "",
        command: "",
        exitCode: null,
        durationMs: 0,
        log: "",
        error: `The worker could not run the job: ${error.message}`,
        findings: [],
      };
    }
    try {
      await post(config, `/api/worker/jobs/${job.id}/result`, { workerId: config.workerId, result });
      console.log(`Job ${job.id}: ${result.outcome}`);
    } catch (error) {
      console.error(`Job ${job.id}: the result could not be delivered: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
