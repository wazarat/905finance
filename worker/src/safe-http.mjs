import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Fetching a page from an address a buyer supplied, without that address
 * being able to turn the worker against anything else.
 *
 * Only http and https, on their usual ports, by name. The name is resolved
 * here, every address it resolves to has to be a public one, and the
 * connection is then made to exactly the address that was checked, so the
 * name cannot answer differently a moment later. Redirects are not followed
 * blindly: each hop is checked the same way. Responses are bounded in size
 * and time. Nothing is ever sent but a plain GET.
 */

const MAX_BODY = 1_500_000;
const TIMEOUT_MS = 15_000;
export const USER_AGENT = "905finance-website-check/1.0 (passive; reads one page)";

function v4Public(address) {
  const [a, b, c] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** True only for an address on the public internet. */
export function isPublicAddress(address) {
  if (net.isIPv4(address)) return v4Public(address);
  if (!net.isIPv6(address)) return false;
  const lower = address.toLowerCase();
  // An IPv4 address written as IPv6, in either notation.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return v4Public(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return v4Public(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  if (lower === "::" || lower === "::1") return false;
  const first = parseInt(lower.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // unique local
  if ((first & 0xffc0) === 0xfe80) return false; // link local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (lower.startsWith("64:ff9b:") || lower.startsWith("2002:") || lower.startsWith("2001:db8:")) return false;
  if (lower.startsWith("2001:0:") || lower.startsWith("2001::")) return false; // Teredo
  return true;
}

/** The address as a URL this worker is willing to fetch, or an Error saying why not. */
export function parseTarget(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new Error("That is not a web address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https addresses can be checked.");
  if (url.username || url.password) throw new Error("The address must not contain a user name or password.");
  if (url.port) throw new Error("Only the usual web ports can be checked.");
  const host = url.hostname.toLowerCase();
  if (net.isIP(host) || host.startsWith("[")) throw new Error("Give the site's name, not a numeric address.");
  if (!host.includes(".") || /\.(local|localhost|internal|lan|home|corp|test|invalid|example)$/.test(host) || host === "localhost") {
    throw new Error("That name is not a site on the public internet.");
  }
  url.hash = "";
  return url;
}

/**
 * One public address for a name, or an Error when the name leads anywhere private.
 * @param {string} hostname
 * @param {any} [lookup] Test hook: stand in for the name service.
 * @returns {Promise<{ address: string, family: number }>}
 */
export async function resolvePublic(hostname, lookup = dns.lookup) {
  let found;
  try {
    found = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`The name ${hostname} could not be found.`);
  }
  if (found.length === 0) throw new Error(`The name ${hostname} could not be found.`);
  if (!found.every((entry) => isPublicAddress(entry.address))) {
    throw new Error("That name leads to a private address, which is never fetched.");
  }
  return found[0];
}

/**
 * One GET, to an address already checked. Never follows a redirect.
 * @returns {Promise<{ url: string, status: number, headers: Record<string, string>, setCookies: string[], body: string, truncated: boolean, certificate: { validTo: string, issuer: string } | null }>}
 */
export function getOnce(url, { resolve = resolvePublic, maxBody = MAX_BODY } = {}) {
  return new Promise((resolvePromise, reject) => {
    resolve(url.hostname).then((pinned) => {
      const secure = url.protocol === "https:";
      const request = (secure ? https : http).request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          servername: secure ? url.hostname : undefined,
          port: secure ? 443 : 80,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "accept-encoding": "identity" },
          // Connect to the address that was checked, whatever the name says now.
          lookup: (_name, options, callback) =>
            options?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
          timeout: TIMEOUT_MS,
          agent: false,
        },
        (response) => {
          const certificate = secure ? response.socket.getPeerCertificate() : null;
          const chunks = [];
          let size = 0;
          let truncated = false;
          response.on("data", (chunk) => {
            if (size >= maxBody) {
              truncated = true;
              return;
            }
            chunks.push(chunk.subarray(0, maxBody - size));
            size += chunk.length;
            if (size >= maxBody) {
              truncated = true;
              response.destroy();
            }
          });
          const finish = () =>
            resolvePromise({
              url: url.href,
              status: response.statusCode ?? 0,
              headers: Object.fromEntries(
                Object.entries(response.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : String(value ?? "")]),
              ),
              setCookies: response.headers["set-cookie"] ?? [],
              body: Buffer.concat(chunks).toString("utf8"),
              truncated,
              certificate: certificate?.valid_to
                ? { validTo: certificate.valid_to, issuer: String(certificate.issuer?.O ?? certificate.issuer?.CN ?? "") }
                : null,
            });
          response.on("end", finish);
          response.on("close", finish);
          response.on("error", finish);
        },
      );
      request.on("timeout", () => request.destroy(new Error("The site took too long to answer.")));
      request.on("error", (error) => reject(new Error(`The site could not be reached: ${error.message}`.slice(0, 200))));
      request.end();
    }, reject);
  });
}

/**
 * GET an address, following up to `maxRedirects` redirects, each one checked
 * like the first. Returns every hop, the last being the page itself.
 */
export async function getFollowing(start, { get = getOnce, maxRedirects = 5 } = {}) {
  const hops = [];
  let url = start;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await get(url);
    hops.push(response);
    const location = response.headers.location;
    if (response.status < 300 || response.status >= 400 || !location) return hops;
    url = parseTarget(new URL(location, url).href);
  }
  throw new Error("The site redirects too many times.");
}
