import { spawn } from "node:child_process";

/** The most output kept from either stream of a test process. */
export const MAX_OUTPUT_BYTES = 200_000;

/**
 * The only environment variables a test process receives. Nothing the worker
 * itself was configured with (its token, the application's address) is passed
 * on, and the worker is never given wallet, database or session credentials
 * in the first place.
 */
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "FOUNDRY_DIR", "SVM_HOME", "XDG_DATA_HOME"];

export function childEnvironment(source = process.env) {
  const env = { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", NODE_ENV: "test" };
  for (const key of ENV_ALLOWLIST) {
    if (typeof source[key] === "string") env[key] = source[key];
  }
  return env;
}

function capture(stream, limit) {
  let size = 0;
  let truncated = false;
  const chunks = [];
  stream.on("data", (chunk) => {
    if (size >= limit) {
      truncated = true;
      return;
    }
    const room = limit - size;
    chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
    size += Math.min(chunk.length, room);
    if (chunk.length > room) truncated = true;
  });
  return () => Buffer.concat(chunks).toString("utf8") + (truncated ? "\n[output truncated]\n" : "");
}

/**
 * Run one command to completion with a hard time limit and bounded output.
 * It never throws for a failing command: a non-zero exit is a result.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, timeoutMs: number, maxStdoutBytes?: number }} options
 * @returns {Promise<{ exitCode: number | null, stdout: string, stderr: string, timedOut: boolean, durationMs: number, spawnError: string | null }>}
 */
export function run(command, args, { cwd, timeoutMs, maxStdoutBytes = MAX_OUTPUT_BYTES }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: childEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so a timeout stops everything it started.
        detached: true,
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, durationMs: 0, spawnError: String(error) });
      return;
    }
    const stdout = capture(child.stdout, maxStdoutBytes);
    const stderr = capture(child.stderr, MAX_OUTPUT_BYTES);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    let spawnError = null;
    child.on("error", (error) => {
      spawnError = String(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdout(),
        stderr: stderr(),
        timedOut,
        durationMs: Date.now() - started,
        spawnError,
      });
    });
  });
}

/** The first line a tool prints for `--version`, or null when it is not installed. */
export async function toolVersion(command, args = ["--version"]) {
  const result = await run(command, args, { cwd: process.cwd(), timeoutMs: 20_000 });
  if (result.spawnError || result.exitCode !== 0) return null;
  const line = `${result.stdout}\n${result.stderr}`.split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 120) : null;
}
