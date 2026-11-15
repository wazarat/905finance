/**
 * A project's shared repository, as an owner and a name on GitHub. Only that
 * pair ever travels to a testing worker; the worker builds the address itself.
 */
export type GitHubRepository = { owner: string; repo: string };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** The repository a URL names, or null when it is not a GitHub repository's address. */
export function parseGitHubRepository(url: string | null | undefined): GitHubRepository | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com")) {
    return null;
  }
  if (parsed.username || parsed.password || parsed.port) return null;
  const [owner, rawName] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !rawName) return null;
  const repo = rawName.replace(/\.git$/, "");
  if (!OWNER.test(owner) || !NAME.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

/** True for a test type that only reads what is shared, and so can be run on a buyer's own project. */
export function isRepositoryCapability(capability: string): boolean {
  return Object.hasOwn(SHARED_CAPABILITIES, capability);
}

/** How jobs for shared repositories are keyed, where a bundled project has its fixture's key. */
export const REPOSITORY_TARGET = "github";

// ---------------------------------------------------------------------------
// Other things a project can share
// ---------------------------------------------------------------------------

/** What a job for a buyer's own project is keyed by, in place of a fixture's key. */
export const SHARED_TARGETS = ["github", "files", "website", "contracts"] as const;
export type SharedTarget = (typeof SHARED_TARGETS)[number];

/** Which shared things each read-only test type can work on, in order of preference. */
export const SHARED_CAPABILITIES: Record<string, readonly SharedTarget[]> = {
  security_scan: ["github", "files"],
  solidity_review: ["github", "files"],
  website_check: ["website"],
  contract_check: ["contracts"],
};

export const FILE_LIMITS = { files: 20, bytesEach: 200 * 1024, bytesTotal: 500 * 1024 } as const;
export const SCRIPT_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"] as const;
export const SOLIDITY_EXTENSIONS = [".sol"] as const;
export const MAX_ADDRESSES = 10;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot).toLowerCase();
}

export function isSharedFileName(name: string): boolean {
  const extension = extensionOf(name);
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) &&
    ([...SCRIPT_EXTENSIONS, ...SOLIDITY_EXTENSIONS] as string[]).includes(extension)
  );
}

/** Which of a project's files a test type reads. */
export function fileExtensionsFor(capability: string): readonly string[] {
  return capability === "solidity_review" ? SOLIDITY_EXTENSIONS : capability === "security_scan" ? SCRIPT_EXTENSIONS : [];
}
