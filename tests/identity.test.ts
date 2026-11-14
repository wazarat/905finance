import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import {
  devIdentityForEmail,
  signInWithAccessToken,
  upsertUserFromIdentity,
} from "@/server/auth/identity";
import type { TokenVerifier } from "@/server/auth/verifier";
import { useTestDatabase } from "./support/db";

/** Stands in for Privy: only tokens it issued verify, everything else throws. */
const fakeVerifier: TokenVerifier = {
  async verify(token) {
    if (token === "valid-alice") {
      return { subject: "did:privy:alice", email: "alice@example.test", displayName: "Alice" };
    }
    if (token === "valid-bob") {
      return { subject: "did:privy:bob", email: null, displayName: null };
    }
    throw new Error("invalid token");
  },
};

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await useTestDatabase());
});
afterAll(async () => close());

describe("sign-in with a verified access token", () => {
  it("creates a user keyed on the verified subject", async () => {
    const user = await signInWithAccessToken(fakeVerifier, "valid-alice");
    expect(user.privyUserId).toBe("did:privy:alice");
    expect(user.email).toBe("alice@example.test");
    expect(user.onboardedAt).toBeNull();
  });

  it("returns the same user on later sign-ins instead of creating another", async () => {
    const first = await signInWithAccessToken(fakeVerifier, "valid-alice");
    const second = await signInWithAccessToken(fakeVerifier, "valid-alice");
    expect(second.id).toBe(first.id);
    const rows = await db.select().from(schema.users);
    expect(rows.filter((u) => u.privyUserId === "did:privy:alice")).toHaveLength(1);
  });

  it("gives different subjects different users", async () => {
    const alice = await signInWithAccessToken(fakeVerifier, "valid-alice");
    const bob = await signInWithAccessToken(fakeVerifier, "valid-bob");
    expect(bob.id).not.toBe(alice.id);
  });

  it("rejects tokens that fail verification and creates nothing", async () => {
    const before = (await db.select().from(schema.users)).length;
    await expect(signInWithAccessToken(fakeVerifier, "forged")).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(signInWithAccessToken(fakeVerifier, "")).rejects.toMatchObject({ code: "invalid" });
    await expect(signInWithAccessToken(fakeVerifier, null)).rejects.toMatchObject({
      code: "invalid",
    });
    expect((await db.select().from(schema.users)).length).toBe(before);
  });

  it("does not overwrite an email already on file", async () => {
    const alice = await signInWithAccessToken(fakeVerifier, "valid-alice");
    const again = await upsertUserFromIdentity({
      subject: "did:privy:alice",
      email: "someone-else@example.test",
      displayName: "Mallory",
    });
    expect(again.id).toBe(alice.id);
    expect(again.email).toBe("alice@example.test");
  });
});

describe("development identities", () => {
  it("derives a stable, namespaced subject from an email", () => {
    expect(devIdentityForEmail("  Dev@Example.Test ")).toEqual({
      subject: "dev:dev@example.test",
      email: "dev@example.test",
      displayName: null,
    });
  });

  it("cannot collide with a Privy subject", () => {
    expect(devIdentityForEmail("a@b.co").subject.startsWith("did:privy:")).toBe(false);
  });

  it("rejects invalid emails", () => {
    for (const bad of ["", "nope", "a@b", "a b@c.d"]) {
      expect(() => devIdentityForEmail(bad), bad).toThrow();
    }
  });
});
