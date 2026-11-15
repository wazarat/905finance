import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { capabilitiesForProject } from "@/lib/capabilities";
import { completeOnboarding } from "@/server/accounts";
import type { Actor } from "@/server/authz";
import { createProject, getProject, listProjectFiles, listProjects } from "@/server/projects";
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

  it("is backed by a database constraint keeping a bundled project and your own apart", async () => {
    const base = {
      organizationId: org,
      hasWeb3: false,
      testingAuthorizedAt: new Date(),
      testingAuthorizedBy: buyer.userId,
      createdBy: buyer.userId,
    };
    // A project of your own cannot also claim a bundled fixture, and a fixture is never tied to a repository.
    await expect(
      db.insert(schema.projects).values({ ...base, name: "Both", sourceType: "repository", fixtureKey: "sample-node-api" }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.projects).values({ ...base, name: "No fixture", sourceType: "fixture" }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.projects).values({
        ...base,
        name: "Fixture with a repository",
        sourceType: "fixture",
        fixtureKey: "sample-node-api",
        repositoryUrl: "https://github.com/example/x",
      }),
    ).rejects.toThrow();
  });
});

describe("sharing your own project", () => {
  const own = { name: "My app", sourceType: "repository", hasWeb3: true, testingAuthorized: true } as const;
  const WALLET = "0xbfb60049d5544050f1ec527275a9f35bcdceedd8";

  it("needs at least one thing shared, and any one of them is enough", async () => {
    const error = await createProject(buyer, org, own).catch((e) => e);
    expect(error.fieldErrors.repositoryUrl[0]).toContain("Share at least one thing");
    for (const shared of [
      { repositoryUrl: "https://github.com/example/app" },
      { applicationUrl: "https://www.example.com" },
      { files: [{ name: "token.sol", content: "contract T {}" }] },
      { contractAddresses: WALLET },
    ]) {
      const project = await createProject(buyer, org, { ...own, ...shared });
      expect(project.sourceType, JSON.stringify(shared)).toBe("repository");
    }
  });

  it("stores addresses in their checked form, once each, and refuses anything that is not one", async () => {
    const project = await createProject(buyer, org, {
      ...own,
      contractAddresses: `${WALLET}\n  0x54B8d8E2455946f2A5B8982283f2359812e815ce, ${WALLET.toUpperCase().replace("0X", "0x")}`,
    });
    expect(project.contractAddresses).toEqual([
      "0xbFB60049D5544050F1Ec527275A9F35bCdcEedD8",
      "0x54B8d8E2455946f2A5B8982283f2359812e815ce",
    ]);
    for (const bad of ["0x1234", "not an address", `${WALLET}00`, "0x" + "g".repeat(40)]) {
      const error = await createProject(buyer, org, { ...own, contractAddresses: bad }).catch((e) => e);
      expect(error.fieldErrors.contractAddresses, bad).toBeDefined();
    }
    const many = Array.from({ length: 11 }, (_, n) => `0x${String(n).padStart(40, "0")}`).join("\n");
    expect((await createProject(buyer, org, { ...own, contractAddresses: many }).catch((e) => e)).fieldErrors.contractAddresses).toBeDefined();
    // A bundled project carries none, whatever is sent with it.
    const fixture = await createProject(buyer, org, { ...validProject, sourceType: "fixture", repositoryUrl: undefined, fixtureKey: "sample-node-api", contractAddresses: WALLET, files: [{ name: "a.ts", content: "x" }] });
    expect(fixture.contractAddresses).toEqual([]);
    expect(await listProjectFiles(buyer, fixture.id)).toEqual([]);
  });

  it("takes source files as text to read, within limits, and nothing else", async () => {
    const project = await createProject(buyer, org, {
      ...own,
      files: [
        { name: "vault.sol", content: "contract Vault {}" },
        { name: "api.ts", content: "export const a = 1;" },
      ],
    });
    expect(await listProjectFiles(buyer, project.id)).toEqual([
      { id: expect.any(String), name: "api.ts", bytes: 19 },
      { id: expect.any(String), name: "vault.sol", bytes: 17 },
    ]);
    const refuse = async (files: Array<{ name: string; content: string }>, words: string) => {
      const error = await createProject(buyer, org, { ...own, files }).catch((e) => e);
      expect(error.fieldErrors?.files?.[0] ?? error.message, words).toContain(words);
    };
    await refuse([{ name: "../../etc/passwd", content: "x" }], "cannot be shared");
    await refuse([{ name: "run.sh", content: "rm -rf /" }], "cannot be shared");
    await refuse([{ name: "page.html", content: "<script>" }], "cannot be shared");
    await refuse([{ name: ".env", content: "SECRET=1" }], "cannot be shared");
    await refuse([{ name: "a.ts", content: "" }], "is empty");
    await refuse([{ name: "a.ts", content: "x\u0000y" }], "not a text file");
    await refuse([{ name: "a.ts", content: "x" }, { name: "A.ts", content: "y" }], "both named");
    await refuse([{ name: "big.ts", content: "x".repeat(200 * 1024 + 1) }], "larger than 200 KB");
    await refuse(Array.from({ length: 3 }, (_, n) => ({ name: `f${n}.ts`, content: "x".repeat(190 * 1024) })), "larger than 500 KB");
    await refuse(Array.from({ length: 21 }, (_, n) => ({ name: `f${n}.ts`, content: "x" })), "at most 20 files");
  });

  it("shows a project's files to its own organization only", async () => {
    const project = await createProject(buyer, org, { ...own, files: [{ name: "a.ts", content: "export {};" }] });
    const outsider = await createUser(db, "outsider");
    await completeOnboarding(outsider, { displayName: "Out Sider", organizationName: "Elsewhere", accountType: "business", roles: "buyer" });
    await expect(listProjectFiles(outsider, project.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(listProjectFiles(null, project.id)).rejects.toMatchObject({ code: "unauthenticated" });
    // What is listed is a name and a size. The text is only ever handed to a worker that has the job.
    expect(JSON.stringify(await listProjectFiles(buyer, project.id))).not.toContain("export");
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
