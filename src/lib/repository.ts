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

/** The test types that only read code, and so can be run on a shared repository. */
export const REPOSITORY_CAPABILITIES = ["security_scan"] as const;

export function isRepositoryCapability(capability: string): boolean {
  return (REPOSITORY_CAPABILITIES as readonly string[]).includes(capability);
}

/** How jobs for shared repositories are keyed, where a bundled project has its fixture's key. */
export const REPOSITORY_TARGET = "github";
