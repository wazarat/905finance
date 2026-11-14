/** Only same-site relative paths are accepted as post-login destinations. */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (
    !next ||
    !next.startsWith("/") ||
    next.startsWith("//") ||
    next.includes("\\") ||
    /[\u0000-\u001f]/.test(next)
  ) {
    return fallback;
  }
  return next;
}

/** URL-safe slug from free text, e.g. "Acme Labs, Inc." -> "acme-labs-inc". */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
