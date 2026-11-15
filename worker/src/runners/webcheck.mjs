import { getFollowing, getOnce, parseTarget } from "../safe-http.mjs";

/**
 * A passive look at a website: what any visitor's browser is told when it
 * opens the page. A handful of plain GET requests, nothing submitted, no
 * guessing at addresses, no probing for weaknesses. Every finding quotes what
 * the site actually sent, or says what it did not send.
 */

const finding = (title, severity, location, evidence, recommendation) => ({
  title,
  severity,
  category: "configuration",
  location,
  evidence: String(evidence).slice(0, 2000),
  recommendation,
});

const SESSION_NAME = /sess|auth|token|sid|jwt|login|csrf/i;

function attribute(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

/** Findings from the page's response headers. */
export function inspectHeaders(page) {
  const found = [];
  const headers = page.headers;
  const secure = page.url.startsWith("https:");
  const quote = (name) => `${name}: ${headers[name]}`;
  const csp = headers["content-security-policy"] ?? "";

  if (secure) {
    const hsts = headers["strict-transport-security"];
    if (!hsts) {
      found.push(finding("No Strict-Transport-Security header", "medium", "strict-transport-security", "The header was not sent.", "Send Strict-Transport-Security with a max-age of at least six months, so browsers refuse to use the site over plain http."));
    } else {
      const age = Number(/max-age\s*=\s*"?(\d+)/i.exec(hsts)?.[1] ?? 0);
      if (age < 15_552_000) {
        found.push(finding("Strict-Transport-Security is short-lived", "low", "strict-transport-security", quote("strict-transport-security"), "Raise max-age to at least 15552000 (six months)."));
      }
    }
  }
  if (!csp) {
    found.push(finding("No Content-Security-Policy header", "medium", "content-security-policy", "The header was not sent.", "Send a Content-Security-Policy that names where scripts may come from. It is the main defence against injected scripts."));
  } else {
    const scripts = /(?:^|;)\s*(?:script-src|default-src)\s([^;]*)/i.exec(csp)?.[1] ?? "";
    const weak = ["'unsafe-inline'", "'unsafe-eval'"].filter((token) => scripts.includes(token));
    if (/(?:^|\s)\*(?:\s|$)/.test(scripts)) weak.push("*");
    if (weak.length > 0) {
      found.push(finding(`Content-Security-Policy allows ${weak.join(" and ")} for scripts`, "low", "content-security-policy", quote("content-security-policy"), "Remove these allowances and use nonces or hashes for the inline scripts you need."));
    }
  }
  if (!headers["x-frame-options"] && !/frame-ancestors/i.test(csp)) {
    found.push(finding("The page can be framed by any site", "medium", "x-frame-options", "Neither X-Frame-Options nor a frame-ancestors policy was sent.", "Send Content-Security-Policy: frame-ancestors 'self' (or X-Frame-Options: DENY) so the page cannot be embedded to trick clicks."));
  }
  if ((headers["x-content-type-options"] ?? "").toLowerCase() !== "nosniff") {
    found.push(finding("No X-Content-Type-Options: nosniff", "low", "x-content-type-options", headers["x-content-type-options"] ? quote("x-content-type-options") : "The header was not sent.", "Send X-Content-Type-Options: nosniff so browsers do not guess a file's type."));
  }
  if (!headers["referrer-policy"]) {
    found.push(finding("No Referrer-Policy header", "low", "referrer-policy", "The header was not sent.", "Send Referrer-Policy: strict-origin-when-cross-origin so full addresses are not passed to other sites."));
  }
  if (!headers["permissions-policy"]) {
    found.push(finding("No Permissions-Policy header", "info", "permissions-policy", "The header was not sent.", "Send a Permissions-Policy that switches off the browser features the site does not use."));
  }
  if (headers["access-control-allow-origin"] === "*" && /true/i.test(headers["access-control-allow-credentials"] ?? "")) {
    found.push(finding("Cross-origin requests with credentials are allowed from anywhere", "medium", "access-control-allow-origin", `${quote("access-control-allow-origin")}\n${quote("access-control-allow-credentials")}`, "Name the origins that may make credentialed requests instead of allowing all."));
  }
  for (const name of ["server", "x-powered-by", "x-aspnet-version"]) {
    if (headers[name] && /\d/.test(headers[name])) {
      found.push(finding(`The ${name} header discloses a software version`, "low", name, quote(name), "Remove the version. It tells an attacker which known weaknesses to try."));
    }
  }
  for (const cookie of page.setCookies.slice(0, 10)) {
    const name = cookie.split("=")[0].trim().slice(0, 60);
    const flags = cookie.toLowerCase();
    const missing = [
      secure && !/;\s*secure/.test(flags) ? "Secure" : null,
      !/;\s*httponly/.test(flags) ? "HttpOnly" : null,
      !/;\s*samesite=/.test(flags) ? "SameSite" : null,
    ].filter(Boolean);
    if (missing.length > 0) {
      const session = SESSION_NAME.test(name);
      found.push(
        finding(
          `Cookie "${name}" is set without ${missing.join(", ")}`,
          session && missing.some((flag) => flag !== "SameSite") ? "medium" : "low",
          `set-cookie: ${name}`,
          // The cookie's value is never recorded.
          `set-cookie: ${name}=…; ${cookie.split(";").slice(1).join(";").trim() || "(no attributes)"}`,
          "Set Secure, HttpOnly and SameSite on cookies, most of all on any that identify a session.",
        ),
      );
    }
  }
  return found;
}

/** Findings from the page's own HTML. */
export function inspectHtml(page) {
  const found = [];
  const secure = page.url.startsWith("https:");
  const origin = new URL(page.url).host;
  const tags = page.body.match(/<(?:script|link|img|iframe|form|input)\b[^>]*>/gi) ?? [];
  const insecure = [];
  const unpinned = [];
  for (const tag of tags.slice(0, 2_000)) {
    const kind = /^<(\w+)/.exec(tag)[1].toLowerCase();
    const source = attribute(tag, kind === "link" ? "href" : kind === "form" ? "action" : "src");
    if (kind === "form") {
      if (source && /^http:\/\//i.test(source)) {
        found.push(finding("A form submits over plain http", "high", page.url, tag.slice(0, 300), "Submit forms to an https address."));
      }
      continue;
    }
    if (kind === "input") {
      if (!secure && /type\s*=\s*["']?password/i.test(tag)) {
        found.push(finding("A password is asked for on a page without HTTPS", "high", page.url, tag.slice(0, 300), "Serve the page, and everything it loads, over https."));
      }
      continue;
    }
    if (!source) continue;
    if (secure && /^http:\/\//i.test(source)) insecure.push({ kind, tag });
    if (kind === "script" && /^(?:https?:)?\/\//i.test(source)) {
      let host = "";
      try {
        host = new URL(source, page.url).host;
      } catch {
        host = "";
      }
      if (host && host !== origin && attribute(tag, "integrity") === null) unpinned.push(tag);
    }
  }
  if (insecure.length > 0) {
    const scripts = insecure.filter((entry) => entry.kind === "script" || entry.kind === "iframe");
    found.push(
      finding(
        `${insecure.length} ${insecure.length === 1 ? "resource is" : "resources are"} loaded over plain http`,
        scripts.length > 0 ? "medium" : "low",
        page.url,
        insecure.slice(0, 5).map((entry) => entry.tag.slice(0, 200)).join("\n"),
        "Load every resource over https. Anything loaded over http can be changed on the way.",
      ),
    );
  }
  if (unpinned.length > 0) {
    found.push(
      finding(
        `${unpinned.length} ${unpinned.length === 1 ? "script from another site has" : "scripts from other sites have"} no integrity check`,
        "low",
        page.url,
        unpinned.slice(0, 5).map((tag) => tag.slice(0, 200)).join("\n"),
        "Add an integrity attribute to scripts from other sites, so a changed file is refused.",
      ),
    );
  }
  return found;
}

/**
 * Look at one website.
 * @param {string} address
 * @param {{ get?: typeof getOnce, now?: number }} [options] Test hook: stand in for the network.
 */
export async function inspectWebsite(address, { get = getOnce, now = Date.now() } = {}) {
  const requests = [];
  const fetchOne = async (url) => {
    const response = await get(url);
    requests.push(`GET ${response.url} -> ${response.status}`);
    return response;
  };
  const target = parseTarget(address);
  const hops = await getFollowing(target, { get: fetchOne });
  const page = hops.at(-1);
  const final = new URL(page.url);
  const findings = [];

  if (final.protocol !== "https:") {
    findings.push(finding("The site is served without HTTPS", "high", page.url, `The page was delivered from ${page.url}.`, "Serve the site over https only, and redirect http to it."));
  } else {
    // Does plain http lead to https?
    try {
      const plain = await fetchOne(new URL(`http://${final.host}/`));
      const location = plain.headers.location ?? "";
      if (!(plain.status >= 300 && plain.status < 400 && /^https:\/\//i.test(location))) {
        findings.push(finding("Plain http is not redirected to https", "medium", `http://${final.host}/`, `GET http://${final.host}/ answered ${plain.status}${location ? ` with location: ${location}` : ""}.`, "Redirect every http request to the https address."));
      }
    } catch {
      // Nothing answers on plain http at all, which is fine.
      requests.push(`GET http://${final.host}/ -> no answer`);
    }
    if (page.certificate) {
      const days = Math.floor((Date.parse(page.certificate.validTo) - now) / 86_400_000);
      if (Number.isFinite(days) && days < 14) {
        findings.push(finding(days < 0 ? "The certificate has expired" : `The certificate expires in ${days} days`, days < 0 ? "high" : "medium", final.host, `Valid until ${page.certificate.validTo}${page.certificate.issuer ? `, issued by ${page.certificate.issuer}` : ""}.`, "Renew the certificate, and automate renewal."));
      }
    }
  }
  if (page.status >= 400) {
    findings.push(finding(`The page answered ${page.status}`, "info", page.url, `GET ${page.url} answered ${page.status}.`, "Check the address. The headers of an error page may differ from the site's real pages."));
  }
  findings.push(...inspectHeaders(page), ...inspectHtml(page));

  try {
    const contact = await fetchOne(new URL(`${final.protocol}//${final.host}/.well-known/security.txt`));
    if (!(contact.status === 200 && /contact:/i.test(contact.body))) {
      findings.push(finding("No security.txt", "info", "/.well-known/security.txt", `GET /.well-known/security.txt answered ${contact.status}.`, "Publish a security.txt with a contact, so someone who finds a problem knows whom to tell."));
    }
  } catch {
    requests.push("GET /.well-known/security.txt -> no answer");
  }

  return { page, findings, requests };
}

/**
 * @param {{ source?: any, toolVersion?: string | null }} input
 * @returns {Promise<{ tool: string, toolVersion: any, command: string, exitCode: number | null, durationMs: number, log: string, outcome: string, error?: string, findings: any[] }>}
 */
export async function runWebcheck({ source, toolVersion }) {
  const started = Date.now();
  const base = { tool: "webcheck", toolVersion, command: "website check (passive)", exitCode: null };
  let result;
  try {
    result = await inspectWebsite(source?.url);
  } catch (error) {
    return { ...base, durationMs: Date.now() - started, log: "", outcome: "error", error: String(error?.message ?? error).slice(0, 300), findings: [] };
  }
  const serious = result.findings.some((f) => f.severity === "critical" || f.severity === "high" || f.severity === "medium");
  return {
    ...base,
    durationMs: Date.now() - started,
    log: [
      `Looked at ${result.page.url} the way a visitor's browser would.`,
      `${result.requests.length} plain GET ${result.requests.length === 1 ? "request" : "requests"}. Nothing was submitted and no address was guessed at.`,
      ...result.requests,
    ].join("\n"),
    outcome: serious ? "failed" : "passed",
    findings: result.findings,
  };
}
