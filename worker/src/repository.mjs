import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { run } from "./exec.mjs";

/**
 * Fetching a shared repository so that it can be read, never run.
 *
 * A job names a public GitHub repository by its owner and name, and nothing
 * else: this worker builds the address itself, so no job can point it at
 * another host. The download is bounded in size and time. What is unpacked is
 * stripped of links and special files, and bounded again, before any tool
 * sees it. Nothing from the repository is ever installed, built or executed.
 */

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/;

export const LIMITS = {
  archiveBytes: 30 * 1024 * 1024,
  unpackedBytes: 250 * 1024 * 1024,
  files: 30_000,
  downloadMs: 60_000,
  unpackMs: 60_000,
};

/** The owner and name of a repository, or null when they are not ones GitHub could have. */
export function repositoryOf(source) {
  if (!source || source.kind !== "github") return null;
  const { owner, repo } = source;
  if (typeof owner !== "string" || typeof repo !== "string") return null;
  if (!OWNER.test(owner) || !NAME.test(repo) || repo === "." || repo === ".." || repo.endsWith(".git")) return null;
  return { owner, repo };
}

/** The commit a repository's default branch is at now, or null when GitHub will not say. */
async function headCommit({ owner, repo }) {
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/HEAD`, {
      headers: { accept: "application/vnd.github.sha", "user-agent": "testing-worker" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const sha = (await response.text()).trim();
    return SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Download the repository's source archive to `file`, refusing one that is too large. */
async function downloadArchive(repository, revision, file) {
  const url = `https://codeload.github.com/${repository.owner}/${repository.repo}/tar.gz/${revision ?? "HEAD"}`;
  const response = await fetch(url, {
    headers: { "user-agent": "testing-worker" },
    redirect: "error",
    signal: AbortSignal.timeout(LIMITS.downloadMs),
  });
  if (response.status === 404) throw new Error("The repository was not found, or it is not public.");
  if (!response.ok || !response.body) throw new Error(`GitHub answered ${response.status} for the repository's source.`);
  const out = createWriteStream(file);
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > LIMITS.archiveBytes) throw new Error("The repository is too large to scan.");
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
}

/**
 * Make what was unpacked safe to hand to a tool: remove every link and
 * special file, so nothing in the tree leads outside it, and refuse a tree
 * that is too large.
 */
export async function sanitizeTree(root) {
  let files = 0;
  let bytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory)) {
      const full = path.join(directory, entry);
      const stat = await lstat(full);
      if (stat.isDirectory()) {
        pending.push(full);
      } else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        if (files > LIMITS.files || bytes > LIMITS.unpackedBytes) throw new Error("The repository is too large to scan.");
      } else {
        // A symbolic link, device, socket or pipe: none of them is source code.
        await rm(full, { force: true });
      }
    }
  }
  return { files, bytes };
}

/** Unpack a source archive into `target`, dropping its single top-level directory. */
export async function unpackArchive(archive, target) {
  await mkdir(target, { recursive: true });
  const result = await run(
    "tar",
    ["-xzf", archive, "-C", target, "--strip-components=1", "--no-same-owner", "--no-same-permissions"],
    { cwd: target, timeoutMs: LIMITS.unpackMs },
  );
  if (result.timedOut || result.spawnError || result.exitCode !== 0) {
    throw new Error("The repository's source could not be unpacked.");
  }
  return sanitizeTree(target);
}

/**
 * Put a repository's source in `runDir`, ready to be read.
 *
 * @param {{ kind: string, owner: string, repo: string }} source
 * @param {string} runDir An empty directory private to this job.
 * @returns {Promise<{ name: string, revision: string | null, files: number }>}
 */
export async function fetchRepository(source, runDir) {
  const repository = repositoryOf(source);
  if (!repository) throw new Error("The job does not name a repository this worker can fetch.");
  const revision = await headCommit(repository);
  // The archive is kept beside the run directory, never inside what the tool is pointed at.
  const archive = `${runDir}.tar.gz`;
  try {
    await downloadArchive(repository, revision, archive);
    const { files } = await unpackArchive(archive, runDir);
    return { name: `${repository.owner}/${repository.repo}`, revision, files };
  } finally {
    await rm(archive, { force: true });
  }
}
