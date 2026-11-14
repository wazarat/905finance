import { afterEach, describe, expect, it, vi } from "vitest";
import { safeNextPath } from "@/lib/paths";
import { createSessionToken, readSessionToken } from "@/server/auth/session";
import { assertSafeAuthConfiguration, isDevAuthEnabled, sessionSecret } from "@/server/env";

const secret = new TextEncoder().encode("a".repeat(48));
const otherSecret = new TextEncoder().encode("b".repeat(48));
const userId = "3f0b7c7e-0a59-4b6e-9a55-0d6a3f2b1c11";

describe("session tokens", () => {
  it("round-trips a valid session", async () => {
    const token = await createSessionToken({ userId, source: "privy" }, secret);
    expect(await readSessionToken(token, secret)).toEqual({ userId, source: "privy" });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken({ userId, source: "privy" }, otherSecret);
    expect(await readSessionToken(token, secret)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await createSessionToken({ userId, source: "privy" }, secret);
    const [header, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "00000000-0000-4000-8000-000000000000", src: "privy" }),
    ).toString("base64url");
    expect(await readSessionToken(`${header}.${forged}.${signature}`, secret)).toBeNull();
  });

  it("rejects an unsigned (alg=none) token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: userId,
        src: "privy",
        iss: "905finance",
        aud: "905finance:session",
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString("base64url");
    expect(await readSessionToken(`${header}.${payload}.`, secret)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = await createSessionToken({ userId, source: "dev" }, secret, -60);
    expect(await readSessionToken(token, secret)).toBeNull();
  });

  it("rejects missing and malformed tokens", async () => {
    expect(await readSessionToken(undefined, secret)).toBeNull();
    expect(await readSessionToken("", secret)).toBeNull();
    expect(await readSessionToken("not-a-token", secret)).toBeNull();
  });
});

describe("auth configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires a session secret of adequate length", () => {
    vi.stubEnv("SESSION_SECRET", "short");
    expect(() => sessionSecret()).toThrow();
    vi.stubEnv("SESSION_SECRET", "x".repeat(32));
    expect(sessionSecret()).toBeInstanceOf(Uint8Array);
  });

  it("enables development sign-in only outside production and only when requested", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("AUTH_MODE", "");
    expect(isDevAuthEnabled()).toBe(false);
    vi.stubEnv("AUTH_MODE", "dev");
    expect(isDevAuthEnabled()).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect(isDevAuthEnabled()).toBe(false);
  });

  it("refuses to start in production with development sign-in requested", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_MODE", "dev");
    expect(() => assertSafeAuthConfiguration()).toThrow(/not permitted in production/);
    vi.stubEnv("AUTH_MODE", "");
    expect(() => assertSafeAuthConfiguration()).not.toThrow();
  });
});

describe("post-login redirect", () => {
  it("accepts same-site paths", () => {
    expect(safeNextPath("/projects/new")).toBe("/projects/new");
    expect(safeNextPath("/engagements/new?seller=relay-qa")).toBe("/engagements/new?seller=relay-qa");
  });

  it("falls back for anything that could leave the site", () => {
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "evil",
      "",
      null,
      undefined,
    ]) {
      expect(safeNextPath(bad), String(bad)).toBe("/dashboard");
    }
  });
});
