import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Fetching a document from an address someone else chose.
 *
 * An agent's registration file lives wherever its owner says it does, so the
 * address is untrusted input. This reads only public HTTPS addresses (or
 * IPFS, through a public gateway, or an inline data: document), follows no
 * redirects, waits a few seconds at most, and stops reading after a fixed
 * size. It never reaches an address inside a private network.
 */

const MAX_BYTES = 100_000;
const TIMEOUT_MS = 8_000;
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

export type FetchedDocument = { ok: true; json: unknown } | { ok: false; reason: string };

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const lower = address.toLowerCase();
  // An IPv4 address carried inside an IPv6 one, written either way
  // (::ffff:10.0.0.1 or ::ffff:a00:1), is judged as the IPv4 address it is.
  const mapped = /^(?:0{0,4}:){2,5}ffff:(.+)$/.exec(lower) ?? /^::ffff:(.+)$/.exec(lower);
  if (mapped) {
    const tail = mapped[1];
    if (isIP(tail) === 4) return isPrivateAddress(tail);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return true;
  }
  // Anything else that embeds or translates an IPv4 address is not read at all.
  if (lower.startsWith("64:ff9b:") || lower.startsWith("2002:")) return true;
  return (
    lower === "::" || lower === "::1" ||
    lower.startsWith("fc") || lower.startsWith("fd") ||
    lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb") ||
    lower.startsWith("ff")
  );
}

type Resolver = (hostname: string) => Promise<string[]>;
const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true })).map((entry) => entry.address);

let resolver: Resolver = systemResolver;
let fetcher: typeof fetch | undefined;

/** Test hooks: substitute name resolution and the network, or restore them with undefined. */
export function setSafeFetchHooks(hooks: { resolve?: Resolver; fetch?: typeof fetch } | undefined): void {
  resolver = hooks?.resolve ?? systemResolver;
  fetcher = hooks?.fetch;
}

function parse(text: string): FetchedDocument {
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "The document is not JSON." };
  }
}

export async function fetchPublicJson(uri: string): Promise<FetchedDocument> {
  const trimmed = uri.trim();
  if (trimmed.length === 0 || trimmed.length > 2_000) return { ok: false, reason: "There is no usable address." };

  // An inline document: nothing to fetch.
  const inline = /^data:application\/json(;charset=[\w-]+)?(;base64)?,(.*)$/is.exec(trimmed);
  if (inline) {
    if (inline[3].length > MAX_BYTES * 2) return { ok: false, reason: "The document is too large." };
    try {
      return parse(inline[2] ? Buffer.from(inline[3], "base64").toString("utf8") : decodeURIComponent(inline[3]));
    } catch {
      return { ok: false, reason: "The inline document could not be decoded." };
    }
  }

  const ipfs = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]{20,100}(?:\/[\w./-]{0,200})?)$/.exec(trimmed);
  let url: URL;
  try {
    url = new URL(ipfs ? `${IPFS_GATEWAY}${ipfs[1]}` : trimmed);
  } catch {
    return { ok: false, reason: "The address is not a valid URL." };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "Only https, ipfs and inline documents are read." };
  if (url.username || url.password) return { ok: false, reason: "The address must not contain credentials." };
  if (url.port && url.port !== "443") return { ok: false, reason: "Only the standard https port is read." };

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(hostname) ? [hostname] : await resolver(hostname);
  } catch {
    return { ok: false, reason: "The address could not be resolved." };
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    return { ok: false, reason: "The address does not point to a public host." };
  }

  try {
    const response = await (fetcher ?? fetch)(url, {
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      return { ok: false, reason: "The address redirects elsewhere, which is not followed." };
    }
    if (!response.ok) return { ok: false, reason: `The host answered ${response.status}.` };
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) return { ok: false, reason: "The document is too large." };

    const reader = response.body?.getReader();
    if (!reader) return parse(await response.text());
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BYTES) {
        await reader.cancel();
        return { ok: false, reason: "The document is too large." };
      }
      chunks.push(value);
    }
    return parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return { ok: false, reason: "The document could not be fetched." };
  }
}
