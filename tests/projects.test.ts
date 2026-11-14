import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { capabilitiesForProject } from "@/lib/capabilities";
import { completeOnboarding } from "@/server/accounts";
import type { Actor } from "@/server/authz";
import { createProject, getProject, listProjects } from "@/server/projects";
import { createUser, useTestDatabase, validProject } from "./support/db";

let db: Db;
let close: () => Promise<void>;
let buyer: Actor;
let org: string;

beforeAll(async () => {
  ({ db, close } = await useTestDatabase());
  buyer = await createUser(db, "buyer");
  const ws = await completeOnboarding(buyer, {
    displayName: "Bea Buyer",
    organizationName: "Buyer Co",
    accountType: "business",
    roles: "buyer",
  });
  org = ws.organization.id;
});
afterAll(async () => close());

describe("project creation", () => {
  it("creates a conventional project and records who authorized testing", async () => {
    const project = await createProject(buyer, org, validProject);
    expect(project.hasWeb3).toBe(false);
    expect(project.organizationId).toBe(org);
    expect(project.testingAuthorizedBy).toBe(buyer.userId);
    expect(project.testingAuthorizedAt).toBeInstanceOf(Date);
    expect((await getProject(buyer, project.id)).repositoryUrl).toBe(validProject.repositoryUrl);
  });

  it("stores the Web3 answer through the same form", async () => {
    const project = await createProject(buyer, org, {
      ...validProject,
      name: "Vault contracts",
      hasWeb3: true,
    });
    expect(project.hasWeb3).toBe(true);
    expect((await getProject(buyer, project.id)).hasWeb3).toBe(true);
  });

  it("refuses creation without explicit testing authorization", async () => {
    const before = (await listProjects(buyer, org)).length;
    for (const testingAuthorized of [false, undefined, "true", 1]) {
      const error = await createProject(buyer, org, { ...validProject, testingAuthorized }).catch(
        (e) => e,
      );
      expect(error, String(testingAuthorized)).toMatchObject({ code: "invalid" });
    }
    expect((await listProjects(buyer, org)).length).toBe(before);
  });

  it("requires the Web3 question to be answered", async () => {
    const { hasWeb3: _omitted, ...unanswered } = validProject;
    const error = await createProject(buyer, org, unanswered).catch((e) => e);
    expect(error).toMatchObject({ code: "invalid" });
    expect(error.fieldErrors.hasWeb3).toBeDefined();
  });

  it("requires an https repository URL without embedded credentials", async () => {
    for (const repositoryUrl of [
      undefined,
      "",
      "http://github.com/example/repo",
      "git@github.com:example/repo.git",
      "file:///etc/passwd",
      "https://token:x-oauth@github.com/example/repo",
    ]) {
      const error = await createProject(buyer, org, { ...validProject, repositoryUrl }).catch((e) => e);
      expect(error, String(repositoryUrl)).toMatchObject({ code: "invalid" });
      expect(error.fieldErrors.repositoryUrl).toBeDefined();
    }
  });

  it("accepts a bundled fixture in place of a repository", async () => {
    const project = await createProject(buyer, org, {
      name: "Fixture run",
      sourceType: "fixture",
      fixtureKey: "sample-node-api",
      hasWeb3: false,
      testingAuthorized: true,
    });
    expect(project.sourceType).toBe("fixture");
    expect(project.fixtureKey).toBe("sample-node-api");
    expect(project.repositoryUrl).toBeNull();
  });

  it("rejects unknown fixtures, and a contract fixture declared as non-Web3", async () => {
    await expect(
      createProject(buyer, org, {
        name: "Bad fixture",
        sourceType: "fixture",
        fixtureKey: "../../secrets",
        hasWeb3: false,
        testingAuthorized: true,
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    const error = await createProject(buyer, org, {
      name: "Mismatch",
      sourceType: "fixture",
      fixtureKey: "sample-solidity-vault",
      hasWeb3: false,
      testingAuthorized: true,
    }).catch((e) => e);
    expect(error.fieldErrors.hasWeb3).toBeDefined();
  });

  it("ignores attempts to set ownership or authorization fields from input", async () => {
    const project = await createProject(buyer, org, {
      ...validProject,
      name: "Injected fields",
      organizationId: "00000000-0000-4000-8000-000000000000",
      createdBy: "00000000-0000-4000-8000-000000000000",
      testingAuthorizedBy: "00000000-0000-4000-8000-000000000000",
    });
    expect(project.organizationId).toBe(org);
    expect(project.createdBy).toBe(buyer.userId);
    expect(project.testingAuthorizedBy).toBe(buyer.userId);
  });

  it("is backed by a database constraint requiring exactly one source", async () => {
    await expect(
      db.insert(schema.projects).values({
        organizationId: org,
        name: "No source",
        sourceType: "repository",
        hasWeb3: false,
        testingAuthorizedAt: new Date(),
        testingAuthorizedBy: buyer.userId,
        createdBy: buyer.userId,
      }),
    ).rejects.toThrow();
  });
});

describe("Web3 answer configures available testing", () => {
  it("offers conventional testing only when the answer is No", () => {
    const keys = capabilitiesForProject(false).map((c) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining(["unit_testing", "regression_testing", "functional_qa", "api_testing"]),
    );
    expect(keys).not.toContain("foundry_fuzz");
    expect(keys).not.toContain("slither_static_analysis");
  });

  it("adds smart-contract testing on top of conventional testing when the answer is Yes", () => {
    const no = capabilitiesForProject(false).map((c) => c.key);
    const yes = capabilitiesForProject(true).map((c) => c.key);
    expect(yes).toEqual(expect.arrayContaining(no));
    expect(yes).toEqual(
      expect.arrayContaining([
        "solidity_compilation",
        "foundry_unit",
        "foundry_fuzz",
        "invariant_testing",
        "slither_static_analysis",
      ]),
    );
  });
});
