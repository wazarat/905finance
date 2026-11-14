import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { sessionSecret } from "../env";

/**
 * Keys for the Qatom channel. Each is derived from the application's signing
 * secret for one purpose only, so a key used to seal stored tokens can never
 * be the key that signs a message, and one engagement's message key says
 * nothing about another's.
 */
function derive(purpose: string, context = ""): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionSecret(), Buffer.from(context), Buffer.from(purpose), 32));
}

// --- Stored tokens ----------------------------------------------------------

/** Encrypt a token for storage (AES-256-GCM). The output carries its own nonce and tag. */
export function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive("905finance:qatom:token-storage:v1"), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

/** Decrypt a stored token, or null when it was sealed under another key or has been altered. */
export function unseal(sealed: string | null | undefined): string | null {
  const [version, iv, tag, body] = (sealed ?? "").split(".");
  if (version !== "v1" || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derive("905finance:qatom:token-storage:v1"),
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// --- Message signatures -----------------------------------------------------

/**
 * Sign text as one engagement's agent. Qatom tells a seller that a message
 * came through Qatom, not who sent it, so every message carries this proof
 * that it comes from the engagement it names.
 */
export function signForEngagement(engagementId: string, text: string): string {
  return createHmac("sha256", derive("905finance:agent-channel:v1", engagementId)).update(text).digest("hex");
}

export function signatureMatches(engagementId: string, text: string, signature: string): boolean {
  return sameText(signForEngagement(engagementId, text), signature);
}

/** Compare two strings in time that does not depend on where they differ. */
export function sameText(a: string, b: string): boolean {
  const left = createHmac("sha256", "compare").update(a).digest();
  const right = createHmac("sha256", "compare").update(b).digest();
  return timingSafeEqual(left, right);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
