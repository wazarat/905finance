import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { keccak256, stringToBytes } from "viem";
import type { Db } from "@/db/client";
import * as schema from "@/db/schema";
import { completeOnboarding } from "@/server/accounts";
import type { AgentBrain } from "@/server/agent/brain";
import { runAgent } from "@/server/agent/runtime";
import { DemoSellerTransport, setSellerTransportResolver } from "@/server/agent/transport";
import type { Actor } from "@/server/authz";
import {
  authorizeEngagement,
  authorizeFunding,
  createEngagement,
  provisionEngagementWallet,
  saveMandateDraft,
} from "@/server/engagements";
import { createProject } from "@/server/projects";
import { runProofs } from "@/server/proofs";
import { createOffering, saveSellerEndpoint, updateSellerListing } from "@/server/sellers";
import { claimTestingJob, setRepositoryProbe, submitTestingResult, workerSupport } from "@/server/testing/jobs";
import { getTestingReport } from "@/server/testing/reports";
import { depositSimulatedFunds } from "@/server/wallets";
import {
  createUser,
  fixtureProject,
  markSample,
  platformActivate,
  registerWorker,
  useTestDatabase,
  validEndpoint,
  validListing,
} from "./support/db";
import { executeJob } from "../worker/src/job.mjs";
import { planFor, supportedPairs } from "../worker/src/plans.mjs";
import { runChaincheck } from "../worker/src/runners/chaincheck.mjs";
import { parseSolhintReport, runSolhint } from "../worker/src/runners/solhint.mjs";
import { inspectHeaders, inspectHtml, inspectWebsite, runWebcheck } from "../worker/src/runners/webcheck.mjs";
import { getFollowing, isPublicAddress, parseTarget, resolvePublic } from "../worker/src/safe-http.mjs";
import { detectTools } from "../worker/src/tools.mjs";

/**
 * Milestone 12: sharing a website, a few source files or contract addresses
 * instead of a repository, and the first-look report each one opens up.
 */

let db: Db;
let close: () => Promise<void>;

const CAPABILITIES = ["security_scan", "solidity_review", "website_check", "contract_check", "unit_testing"];
const PAIRS = [
  "github:security_scan",
  "github:solidity_review",
  "files:security_scan",
  "files:solidity_review",
  "website:website_check",
  "contracts:contract_check",
];
const REGISTRY = "0x54B8d8E2455946f2A5B8982283f2359812e815ce";
const WALLET = "0xbFB60049D5544050F1Ec527275A9F35bCdcEedD8";
const own = { sourceType: "repository", hasWeb3: true, testingAuthorized: true } as const;

let buyer: Actor;
let org: string;
let seller: { slug: string; offering: Record<string, string> };

async function engage(projectId: string): Promise<string> {
  const engagement = await createEngagement(buyer, org, { sellerSlug: seller.slug, projectId });
  await saveMandateDraft(buyer, engagement.id, {
    rail: "goat",
    totalBudget: "100",
    perTransactionLimit: "25",
    offeringIds: Object.values(seller.offering),
    scope: "Take a first look and report what you find.",
    expiresInDays: 30,
  });
  await authorizeEngagement(buyer, engagement.id, { confirmed: true });
  await provisionEngagementWallet(buyer, engagement.id);
  await authorizeFunding(buyer, engagement.id, { amount: "100", idempotencyKey: randomUUID(), confirmed: true });
  return engagement.id;
}

/** An agent that buys exactly the named services, in order, then stops. */
function buying(capabilities: string[]): AgentBrain {
  const queue = [...capabilities];
  return {
    name: "test",
    async next() {
      const capability = queue.shift();
      return capability
        ? { tool: "purchase_service", input: { offeringId: seller.offering[capability], reason: "test" } }
        : { tool: "finish", input: { summary: "Done." } };
    },
  };
}

const buy = (engagementId: string, capabilities: string[]) =>
  runAgent(buyer, engagementId, { runKey: randomUUID() }, buying(capabilities));

const jobsOf = (engagementId: string) =>
  db.select().from(schema.testingJobs).where(eq(schema.testingJobs.engagementId, engagementId)).orderBy(schema.testingJobs.sequence);

const purchasesOf = (engagementId: string) =>
  db.select().from(schema.purchases).where(eq(schema.purchases.engagementId, engagementId));

const claim = (supports = PAIRS, workerId = "reader") => claimTestingJob({ workerId, tools: { eslint: "x", solhint: "x", webcheck: "1", chaincheck: "1" }, supports });

/** Buy one first look on a project, expecting it to be sold. */
async function sold(projectId: string, capability: string) {
  const engagementId = await engage(projectId);
  const result = await buy(engagementId, [capability]);
  expect(result.run.purchasesCompleted, result.run.summary ?? "").toBe(1);
  const [job] = await jobsOf(engagementId);
  return { engagementId, job };
}

/** Try to buy one first look on a project, expecting the seller to decline before any payment. */
async function declined(projectId: string, capability: string) {
  const engagementId = await engage(projectId);
  const result = await buy(engagementId, [capability]);
  expect(result.run.purchasesCompleted).toBe(0);
  expect(await purchasesOf(engagementId)).toEqual([]);
  expect(await jobsOf(engagementId)).toEqual([]);
  return result.run.summary ?? "";
}

const report = (tool: string, category: string, overrides: Record<string, unknown> = {}) => ({
  outcome: "failed",
  tool,
  toolVersion: "1",
  command: "first look",
  exitCode: null,
  durationMs: 420,
  log: "Read what was shared.",
  findings: [
    {
      title: "No Content-Security-Policy header",
      severity: "medium",
      category,
      location: "content-security-policy",
      evidence: "The header was not sent.",
      recommendation: "Send one.",
    },
    {
      title: "No Permissions-Policy header",
      severity: "info",
      category,
      location: "permissions-policy",
      evidence: "The header was not sent.",
      recommendation: "Send one.",
    },
  ],
  ...overrides,
});

beforeAll(async () => {
  ({ db, close } = await useTestDatabase());
  const sellerOwner = await createUser(db, "harbor-owner");
  const sellerWs = await completeOnboarding(sellerOwner, {
    displayName: "Harbor owner",
    organizationName: "Harbor agents",
    accountType: "business",
    roles: "seller",
  });
  await updateSellerListing(sellerOwner, sellerWs.organization.id, {
    ...validListing,
    displayName: "Harbor agents",
    capabilities: CAPABILITIES,
    intendedRails: ["goat"],
  });
  await saveSellerEndpoint(sellerOwner, sellerWs.organization.id, validEndpoint);
  const offering: Record<string, string> = {};
  for (const capability of CAPABILITIES) {
    const created = await createOffering(sellerOwner, sellerWs.organization.id, {
      name: `Run ${capability}`,
      description: "",
      capability,
      billingUnit: "per_run",
      priceMinor: 1000,
    });
    offering[capability] = created.id;
  }
  await platformActivate(db, sellerWs.sellerProfile!.slug);
  await markSample(db, sellerWs.sellerProfile!.slug);
  seller = { slug: sellerWs.sellerProfile!.slug, offering };

  buyer = await createUser(db, "pier-owner");
  const buyerWs = await completeOnboarding(buyer, {
    displayName: "Pier owner",
    organizationName: "Pier software",
    accountType: "business",
    roles: "buyer",
  });
  org = buyerWs.organization.id;
  await depositSimulatedFunds(buyer, org, { rail: "goat", amount: "1000000" });
});
afterAll(async () => close());

let asked = 0;
beforeEach(async () => {
  asked = 0;
  setRepositoryProbe(async () => {
    asked += 1;
    return { exists: true, languages: ["TypeScript", "Solidity"] };
  });
  setSellerTransportResolver((context) => new DemoSellerTransport(context));
  await db.delete(schema.testingWorkers);
  await db
    .update(schema.testingJobs)
    .set({ status: "failed", failureReason: "left over from another test" })
    .where(eq(schema.testingJobs.status, "queued"));
  await db
    .update(schema.testingJobs)
    .set({ status: "failed", failureReason: "left over from another test" })
    .where(eq(schema.testingJobs.status, "running"));
  await registerWorker(db, PAIRS);
});
afterEach(() => {
  setRepositoryProbe(undefined);
  setSellerTransportResolver(undefined);
});

describe("a first look at what a project shares", () => {
  it("reads a website when only a website is shared, and asks GitHub nothing", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Site only", applicationUrl: "https://www.example.com/app" });
    const { job } = await sold(project.id, "website_check");
    expect(job).toMatchObject({
      capability: "website_check",
      fixtureKey: "website",
      source: { kind: "website", url: "https://www.example.com/app" },
      status: "queued",
    });
    expect(asked).toBe(0);
    // The worker is told the address, and nothing about the buyer, the engagement or money.
    expect(await claim()).toEqual({
      id: job.id,
      fixtureKey: "website",
      capability: "website_check",
      source: { kind: "website", url: "https://www.example.com/app" },
    });
    // Nothing else was shared, so nothing else is sold.
    expect(await declined(project.id, "security_scan")).toContain("shares no JavaScript or TypeScript");
    expect(await declined(project.id, "solidity_review")).toContain("shares no Solidity");
    expect(await declined(project.id, "contract_check")).toContain("shares no contract addresses");
    expect(await declined(project.id, "unit_testing")).toContain("runs the project's code");
  });

  it("hands a worker only the shared files its tool reads", async () => {
    const project = await createProject(buyer, org, {
      ...own,
      name: "Files only",
      files: [
        { name: "vault.sol", content: "contract Vault {}\n" },
        { name: "api.ts", content: "export const a = 1;\n" },
        { name: "util.mjs", content: "export const b = 2;\n" },
      ],
    });
    const scan = await sold(project.id, "security_scan");
    expect(scan.job).toMatchObject({ fixtureKey: "files", source: { kind: "files" } });
    expect(await claim()).toEqual({
      id: scan.job.id,
      fixtureKey: "files",
      capability: "security_scan",
      source: { kind: "files" },
      files: [
        { name: "api.ts", content: "export const a = 1;\n" },
        { name: "util.mjs", content: "export const b = 2;\n" },
      ],
    });
    const review = await sold(project.id, "solidity_review");
    // A second worker: one that checks in again is taken to have dropped what it was running.
    expect((await claim(PAIRS, "second-reader"))!.files).toEqual([{ name: "vault.sol", content: "contract Vault {}\n" }]);
    expect(review.job.fixtureKey).toBe("files");
    expect(asked).toBe(0);
    expect(await declined(project.id, "website_check")).toContain("no website address");

    // Solidity alone is nothing for the JavaScript scan to read.
    const contracts = await createProject(buyer, org, { ...own, name: "Solidity only", files: [{ name: "token.sol", content: "contract T {}" }] });
    expect(await declined(contracts.id, "security_scan")).toContain("shares no JavaScript or TypeScript");
  });

  it("reads addresses on GOAT when addresses are shared", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Addresses only", contractAddresses: `${REGISTRY}\n${WALLET.toLowerCase()}` });
    const { job } = await sold(project.id, "contract_check");
    expect(job).toMatchObject({ fixtureKey: "contracts", source: { kind: "contracts", addresses: [REGISTRY, WALLET] } });
    expect((await claim())!.source).toEqual({ kind: "contracts", addresses: [REGISTRY, WALLET] });
    expect(await declined(project.id, "solidity_review")).toContain("shares no Solidity");
  });

  it("prefers the repository when a project shares one as well as files", async () => {
    const project = await createProject(buyer, org, {
      ...own,
      name: "Both",
      repositoryUrl: "https://github.com/example/contracts",
      files: [{ name: "token.sol", content: "contract T {}" }],
    });
    const { job } = await sold(project.id, "solidity_review");
    expect(job).toMatchObject({ fixtureKey: "github", source: { kind: "github", owner: "example", repo: "contracts" } });
    expect((await claim())!.files).toBeUndefined();
    // GitHub is asked before a repository is charged for, and has to report the language the review reads.
    expect(asked).toBeGreaterThan(0);
    setRepositoryProbe(async () => ({ exists: true, languages: ["TypeScript"] }));
    expect(await declined(project.id, "solidity_review")).toContain("no Solidity");
  });

  it("is not sold while no worker can do that kind of reading", async () => {
    await db.delete(schema.testingWorkers);
    await registerWorker(db, ["github:security_scan", "files:security_scan"]);
    const project = await createProject(buyer, org, { ...own, name: "Unreadable", applicationUrl: "https://www.example.com", contractAddresses: REGISTRY });
    expect(await declined(project.id, "website_check")).toContain("No testing worker can run");
    expect(await declined(project.id, "contract_check")).toContain("No testing worker can run");
    // A worker is never given a kind of job it did not say it supports.
    await registerWorker(db, PAIRS);
    const { job } = await sold(project.id, "website_check");
    expect(await claim(["files:security_scan", "contracts:contract_check"])).toBeNull();
    expect((await claim(["website:website_check"]))!.id).toBe(job.id);
  });

  it("is for your own project: a bundled fixture has no website or addresses to read", async () => {
    expect(await workerSupport("sample-node-api", "website_check")).toBe("unsupported");
    expect(await workerSupport("sample-solidity-vault", "contract_check")).toBe("unsupported");
    const fixture = await createProject(buyer, org, { ...fixtureProject, applicationUrl: "https://www.example.com" });
    expect(await declined(fixture.id, "website_check")).toContain("No testing worker can run");
  });
});

describe("a first-look report", () => {
  it("is accepted from the tool that does that reading, and from no other", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Reported site", applicationUrl: "https://www.example.com" });
    const { job } = await sold(project.id, "website_check");
    await claim();
    // A website check cannot be answered with another tool's report.
    await expect(submitTestingResult(job.id, { workerId: "reader", result: report("eslint", "security") })).rejects.toThrow();
    // Nor with a kind of finding the application does not know.
    await expect(submitTestingResult(job.id, { workerId: "reader", result: report("webcheck", "guesswork") })).rejects.toThrow();

    expect(await submitTestingResult(job.id, { workerId: "reader", result: report("webcheck", "configuration") })).toMatchObject({ status: "completed" });
    const read = await getTestingReport(buyer, job.id);
    expect(read.source).toEqual({ kind: "website", url: "https://www.example.com" });
    expect(read.findings.map((f) => f.category)).toEqual(["configuration", "configuration"]);
    const [purchase] = await db.select().from(schema.purchases).where(eq(schema.purchases.id, job.purchaseId));
    expect(purchase.status).toBe("delivered");
    expect(purchase.delivery).toMatchObject({ kind: "test_report", outcome: "failed" });
    expect((purchase.delivery as { summary: string }).summary).toBe("The website check reported 2 findings: 1 medium, 1 informational.");
  });

  it("says plainly when a reading found nothing", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Quiet contracts", contractAddresses: REGISTRY });
    const { job } = await sold(project.id, "contract_check");
    await claim();
    await submitTestingResult(job.id, { workerId: "reader", result: report("chaincheck", "observation", { outcome: "passed", findings: [] }) });
    const [purchase] = await db.select().from(schema.purchases).where(eq(schema.purchases.id, job.purchaseId));
    expect(purchase.delivery).toMatchObject({ outcome: "passed", summary: "The contract check analysed the addresses and reported nothing." });
  });

  it("gets a fingerprint of its own, fixed to the findings it reported", async () => {
    const project = await createProject(buyer, org, { ...own, name: "Proven review", files: [{ name: "token.sol", content: "contract T {}" }] });
    const { engagementId, job } = await sold(project.id, "solidity_review");
    await claim();
    await submitTestingResult(job.id, { workerId: "reader", result: report("solhint", "security") });
    // Proofs are not switched on in tests: fingerprints are taken, and nothing is sent anywhere.
    expect(await runProofs()).toMatchObject({ state: "off", sent: 0 });

    const [record] = await db
      .select()
      .from(schema.proofRecords)
      .where(and(eq(schema.proofRecords.kind, "report"), eq(schema.proofRecords.entityId, job.id)));
    expect(record).toMatchObject({ organizationId: org, engagementId });
    expect(record.recordHash).toBe(keccak256(stringToBytes(record.document)));
    const document = JSON.parse(record.document);
    expect(document).toMatchObject({
      type: "905finance.report.v1",
      id: job.id,
      work: "solidity_review",
      tool: "solhint",
      outcome: "failed",
      tests: null,
      findings: 2,
    });
    expect(document.findingsHash).toBe(
      keccak256(
        stringToBytes(
          JSON.stringify([
            ["medium", "No Content-Security-Policy header", "content-security-policy"],
            ["info", "No Permissions-Policy header", "permissions-policy"],
          ]),
        ),
      ),
    );
    // The fingerprint covers what was found, not the text of what was shared.
    expect(record.document).not.toContain("contract T");
    // One fingerprint per report, however often proofs run.
    await runProofs();
    expect(
      await db.select().from(schema.proofRecords).where(and(eq(schema.proofRecords.kind, "report"), eq(schema.proofRecords.entityId, job.id))),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The worker's readers. Nothing below touches a network: every answer is stood in for.
// ---------------------------------------------------------------------------

type Page = { url: string; status: number; headers: Record<string, string>; setCookies: string[]; body: string; truncated: boolean; certificate: { validTo: string; issuer: string } | null };

const page = (url: string, overrides: Partial<Page> = {}): Page => ({
  url,
  status: 200,
  headers: {},
  setCookies: [],
  body: "<html><body>Hello</body></html>",
  truncated: false,
  certificate: null,
  ...overrides,
});

const HARDENED = {
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=()",
};

describe("fetching an address a buyer supplied", () => {
  it("knows a public address from a private one", () => {
    for (const address of ["8.8.8.8", "76.76.21.21", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "192.0.2.1",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
      "2001:db8::1",
      "not an address",
      "",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("takes only a site's name, over http or https, on the usual ports", () => {
    expect(parseTarget(" https://www.example.org/path?q=1#top ").href).toBe("https://www.example.org/path?q=1");
    expect(parseTarget("http://example.org").href).toBe("http://example.org/");
    for (const bad of [
      "ftp://example.org",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pass@example.org",
      "https://example.org:8443",
      "http://example.org:22",
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://2130706433/",
      "http://0x7f.1/",
      "http://[::1]/",
      "http://localhost/",
      "http://intranet/",
      "http://db.internal/",
      "http://printer.local/",
      "http://router.lan/",
      "not a url",
      "",
    ]) {
      expect(() => parseTarget(bad), bad).toThrow();
    }
  });

  it("refuses a name that leads anywhere private, even among public answers", async () => {
    const answers = (...addresses: string[]) => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    expect(await resolvePublic("www.example.org", answers("76.76.21.21", "76.76.21.22"))).toEqual({ address: "76.76.21.21", family: 4 });
    await expect(resolvePublic("rebind.example.org", answers("76.76.21.21", "127.0.0.1"))).rejects.toThrow("private address");
    await expect(resolvePublic("meta.example.org", answers("169.254.169.254"))).rejects.toThrow("private address");
    await expect(resolvePublic("six.example.org", answers("::ffff:10.0.0.1"))).rejects.toThrow("private address");
    await expect(resolvePublic("empty.example.org", answers())).rejects.toThrow("could not be found");
    await expect(
      resolvePublic("gone.example.org", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow("could not be found");
  });

  it("checks every redirect like the first address, and gives up on a loop", async () => {
    const seen: string[] = [];
    const redirecting = (map: Record<string, string>) => async (url: URL) => {
      seen.push(url.href);
      const location = map[url.href];
      return location ? page(url.href, { status: 302, headers: { location } }) : page(url.href);
    };
    const hops = await getFollowing(parseTarget("http://example.org/"), {
      get: redirecting({ "http://example.org/": "https://example.org/", "https://example.org/": "/home" }),
    });
    expect(hops.map((hop: Page) => hop.url)).toEqual(["http://example.org/", "https://example.org/", "https://example.org/home"]);

    // A public site that points at something private is followed no further.
    for (const location of ["http://169.254.169.254/latest/meta-data/", "http://localhost/admin", "https://example.org:8443/", "file:///etc/passwd", "http://[::1]/"]) {
      seen.length = 0;
      await expect(getFollowing(parseTarget("https://example.org/"), { get: redirecting({ "https://example.org/": location }) }), location).rejects.toThrow();
      expect(seen).toEqual(["https://example.org/"]);
    }
    await expect(getFollowing(parseTarget("https://example.org/"), { get: async (url: URL) => page(url.href, { status: 301, headers: { location: "/again" } }) })).rejects.toThrow(
      "too many times",
    );
  });
});

describe("the website check", () => {
  it("reports nothing for a page that sends every header", () => {
    const hardened = page("https://www.example.org/", { headers: HARDENED, setCookies: ["session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax"] });
    expect(inspectHeaders(hardened)).toEqual([]);
    expect(inspectHtml(hardened)).toEqual([]);
  });

  it("says which protections a page did not send, quoting what it did send", () => {
    const found = inspectHeaders(
      page("https://www.example.org/", {
        headers: {
          "strict-transport-security": "max-age=300",
          "content-security-policy": "script-src 'self' 'unsafe-inline' 'unsafe-eval' *",
          server: "nginx/1.18.0",
          "x-powered-by": "Express",
          "access-control-allow-origin": "*",
          "access-control-allow-credentials": "true",
        },
      }),
    );
    const titles = found.map((f: { title: string }) => f.title);
    expect(titles).toEqual([
      "Strict-Transport-Security is short-lived",
      "Content-Security-Policy allows 'unsafe-inline' and 'unsafe-eval' and * for scripts",
      "The page can be framed by any site",
      "No X-Content-Type-Options: nosniff",
      "No Referrer-Policy header",
      "No Permissions-Policy header",
      "Cross-origin requests with credentials are allowed from anywhere",
      "The server header discloses a software version",
    ]);
    expect(found.every((f: { category: string }) => f.category === "configuration")).toBe(true);
    expect(found[0].evidence).toBe("strict-transport-security: max-age=300");
    // A header that names software without a version tells an attacker little, and is left alone.
    expect(titles.join()).not.toContain("x-powered-by");
    // Plain http has no use for an HSTS header, so its absence is not reported there.
    expect(inspectHeaders(page("http://www.example.org/")).map((f: { title: string }) => f.title)).not.toContain("No Strict-Transport-Security header");
    expect(inspectHeaders(page("https://www.example.org/")).map((f: { title: string }) => f.title)).toContain("No Strict-Transport-Security header");
  });

  it("reports a cookie's missing protections without ever recording its value", () => {
    const found = inspectHeaders(
      page("https://www.example.org/", {
        headers: HARDENED,
        setCookies: ["sessionid=SECRET-VALUE-123; Path=/", "theme=dark-SECRET; Path=/; Secure; HttpOnly", "ok=1; Secure; HttpOnly; SameSite=Strict"],
      }),
    );
    expect(found.map((f: { title: string; severity: string }) => [f.title, f.severity])).toEqual([
      ['Cookie "sessionid" is set without Secure, HttpOnly, SameSite', "medium"],
      ['Cookie "theme" is set without SameSite', "low"],
    ]);
    expect(JSON.stringify(found)).not.toContain("SECRET");
    expect(found[0].evidence).toBe("set-cookie: sessionid=…; Path=/");
  });

  it("reads the page's own HTML for what it loads and where it sends forms", () => {
    const secure = inspectHtml(
      page("https://www.example.org/", {
        body: `<html><head>
          <script src="http://cdn.example.net/a.js"></script>
          <script src="https://cdn.example.net/b.js"></script>
          <script src="https://cdn.example.net/c.js" integrity="sha384-abc" crossorigin="anonymous"></script>
          <script src="/local.js"></script>
          <img src="http://img.example.net/logo.png">
          </head><body><form action="http://www.example.org/login"><input type="password" name="p"></form></body></html>`,
      }),
    );
    expect(secure.map((f: { title: string; severity: string }) => [f.title, f.severity])).toEqual([
      ["A form submits over plain http", "high"],
      ["2 resources are loaded over plain http", "medium"],
      ["2 scripts from other sites have no integrity check", "low"],
    ]);
    const plain = inspectHtml(page("http://www.example.org/", { body: `<form action="/login"><input type=password name=p></form>` }));
    expect(plain.map((f: { title: string }) => f.title)).toEqual(["A password is asked for on a page without HTTPS"]);
  });

  it("makes a handful of plain requests, and reports each one", async () => {
    const asked: string[] = [];
    const site = async (url: URL) => {
      asked.push(url.href);
      if (url.href === "http://www.example.org/") return page(url.href, { status: 200 });
      if (url.pathname === "/.well-known/security.txt") return page(url.href, { status: 404, body: "Not found" });
      return page(url.href, { headers: HARDENED, certificate: { validTo: "Nov 20 12:00:00 2026 GMT", issuer: "Example CA" } });
    };
    const result = await inspectWebsite("https://www.example.org/", { get: site, now: Date.parse("2026-11-14T12:00:00Z") });
    expect(asked).toEqual(["https://www.example.org/", "http://www.example.org/", "https://www.example.org/.well-known/security.txt"]);
    expect(result.requests).toEqual([
      "GET https://www.example.org/ -> 200",
      "GET http://www.example.org/ -> 200",
      "GET https://www.example.org/.well-known/security.txt -> 404",
    ]);
    expect(result.findings.map((f: { title: string; severity: string }) => [f.title, f.severity])).toEqual([
      ["Plain http is not redirected to https", "medium"],
      ["The certificate expires in 6 days", "medium"],
      ["No security.txt", "info"],
    ]);

    // A site that does all of it has nothing reported.
    const good = async (url: URL) =>
      url.protocol === "http:"
        ? page(url.href, { status: 308, headers: { location: `https://${url.host}/` } })
        : url.pathname === "/.well-known/security.txt"
          ? page(url.href, { body: "Contact: mailto:security@example.org" })
          : page(url.href, { headers: HARDENED, certificate: { validTo: "Nov 20 12:00:00 2027 GMT", issuer: "Example CA" } });
    expect((await inspectWebsite("https://www.example.org/", { get: good, now: Date.parse("2026-11-14T12:00:00Z") })).findings).toEqual([]);

    // A site with no HTTPS at all is the first thing said about it.
    const plain = await inspectWebsite("http://www.example.org/", { get: async (url: URL) => page(url.href, { headers: HARDENED }) });
    expect(plain.findings[0]).toMatchObject({ title: "The site is served without HTTPS", severity: "high" });
  });

  it("reports an address it will not open as a check that did not happen", async () => {
    for (const url of ["http://127.0.0.1/", "http://localhost:3000/", "https://db.internal/", "ftp://example.org/", undefined]) {
      const result = await runWebcheck({ source: { kind: "website", url }, toolVersion: "1" });
      expect(result, String(url)).toMatchObject({ outcome: "error", tool: "webcheck", findings: [] });
      expect(result.error).toBeTruthy();
    }
  });
});

const tools = await detectTools();
const SLOT_IMPLEMENTATION = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const word = (address: string) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
const EMPTY_WORD = `0x${"0".repeat(64)}`;

/** A stand-in chain: which addresses hold code, what sits in their slots, and who owns them. */
function chain(state: { code?: Record<string, string>; slots?: Record<string, Record<string, string>>; owners?: Record<string, string> }) {
  const calls: string[] = [];
  const lower = (value: string) => value.toLowerCase();
  const rpc = async (method: string, params: unknown[]) => {
    calls.push(method);
    const address = lower(String(method === "eth_call" ? (params[0] as { to: string }).to : params[0]));
    if (method === "eth_getCode") return state.code?.[address] ?? "0x";
    if (method === "eth_getBalance") return "0x2386f26fc10000";
    if (method === "eth_getTransactionCount") return "0x7";
    if (method === "eth_getStorageAt") return state.slots?.[address]?.[String(params[1])] ?? EMPTY_WORD;
    if (method === "eth_call") {
      const owner = state.owners?.[address];
      if (!owner) throw new Error("execution reverted");
      return word(owner);
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, calls };
}

describe("the contract check", () => {
  const CONTRACT = "0x1111111111111111111111111111111111111111";
  const LOGIC = "0x2222222222222222222222222222222222222222";
  const KEY = "0x3333333333333333333333333333333333333333";
  const SAFE = "0x4444444444444444444444444444444444444444";
  const titles = (result: { findings: Array<{ title: string; severity: string }> }) => result.findings.map((f) => [f.title, f.severity]);

  it("says when an address is an account, with nothing to review", async () => {
    const { rpc } = chain({});
    const explorer = async () => {
      throw new Error("the explorer is not asked about an account");
    };
    const result = await runChaincheck({ source: { kind: "contracts", addresses: [KEY] }, toolVersion: "1" }, { rpc, explorer });
    expect(result).toMatchObject({ outcome: "passed", tool: "chaincheck", command: "contract check on GOAT Testnet3" });
    expect(titles(result)).toEqual([["This address is an account, not a contract", "info"]]);
    expect(result.findings[0]).toMatchObject({ category: "observation", location: KEY });
    expect(result.findings[0].evidence).toContain("has sent 7 transactions and holds 10000000000000000 wei");
    expect(result.log).toContain("Nothing was sent to any of them");
  });

  it("reports a contract whose source nobody can read", async () => {
    const { rpc } = chain({ code: { [CONTRACT]: "0x6080604052" } });
    const result = await runChaincheck({ source: { addresses: [CONTRACT] }, toolVersion: "1" }, { rpc, explorer: async () => null });
    expect(result.outcome).toBe("failed");
    expect(titles(result)).toEqual([["Its source code is not published", "medium"]]);
    expect(result.log).toContain(`${CONTRACT}: a contract, 5 bytes of code.`);
  });

  it("reports who can replace an upgradeable contract's logic", async () => {
    const proxied = (admin: string, code: Record<string, string> = {}) =>
      chain({
        code: { [CONTRACT]: "0x60806040", [LOGIC]: "0x60806040", ...code },
        slots: { [CONTRACT]: { [SLOT_IMPLEMENTATION]: word(LOGIC), [SLOT_ADMIN]: word(admin) } },
      });
    const verified = async () => ({ is_verified: true, name: "Thing", compiler_version: "v0.8.24+commit.e11b9ed9", source_code: "" });

    const single = await runChaincheck({ source: { addresses: [CONTRACT] }, toolVersion: "1" }, { rpc: proxied(KEY).rpc, explorer: verified });
    expect(titles(single)).toEqual([["Its logic can be replaced by a single account", "medium"]]);
    expect(single.findings[0].evidence).toContain(`EIP-1967 implementation slot: ${LOGIC}`);
    expect(single.findings[0].evidence).toContain(`${KEY} has no code: it is an ordinary account, controlled by one key.`);
    expect(single.outcome).toBe("failed");

    // The same proxy behind a contract (a multi-signature wallet, say) is noted, not raised.
    const shared = await runChaincheck({ source: { addresses: [CONTRACT] }, toolVersion: "1" }, { rpc: proxied(SAFE, { [SAFE]: "0x6080" }).rpc, explorer: verified });
    expect(titles(shared)).toEqual([["Its logic can be replaced (upgradeable proxy)", "low"]]);
    expect(shared.outcome).toBe("passed");

    // The explorer is asked about the proxy and about the logic behind it.
    const askedAbout: string[] = [];
    const hidden = await runChaincheck(
      { source: { addresses: [CONTRACT] }, toolVersion: "1" },
      {
        rpc: proxied(SAFE, { [SAFE]: "0x6080" }).rpc,
        explorer: async (address: string) => {
          askedAbout.push(address);
          return address === CONTRACT ? { is_verified: true, name: "Proxy", compiler_version: "v0.8.24", source_code: "" } : null;
        },
      },
    );
    expect(askedAbout).toEqual([CONTRACT, LOGIC]);
    expect(titles(hidden)).toEqual([
      ["The logic contract's source code is not published", "medium"],
      ["Its logic can be replaced (upgradeable proxy)", "low"],
    ]);
  });

  it("notes a contract owned by one key, and one built with an old compiler", async () => {
    const { rpc } = chain({ code: { [CONTRACT]: "0x6080" }, owners: { [CONTRACT]: KEY } });
    const result = await runChaincheck(
      { source: { addresses: [CONTRACT] }, toolVersion: "1" },
      { rpc, explorer: async () => ({ is_verified: true, name: "Old", compiler_version: "v0.6.12+commit.27d51765", source_code: "" }) },
    );
    expect(titles(result)).toEqual([
      ["It is owned by a single account", "low"],
      ["It was built with a compiler older than 0.8", "low"],
    ]);
    expect(result.outcome).toBe("passed");
  });

  it.skipIf(!tools.solhint)("reads a verified contract's published source, leaving its libraries out", { timeout: 120_000 }, async () => {
    const runDir = await realpath(await mkdtemp(path.join(tmpdir(), "chaincheck-")));
    try {
      const { rpc } = chain({ code: { [CONTRACT]: "0x6080" } });
      const result = await runChaincheck(
        { source: { addresses: [CONTRACT] }, runDir, timeoutMs: 60_000, toolVersion: "1" },
        {
          rpc,
          explorer: async () => ({
            is_verified: true,
            name: "Gate",
            compiler_version: "v0.8.24",
            file_path: "src/Gate.sol",
            source_code: "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\ncontract Gate {\n    address public owner;\n    function open() external view returns (bool) {\n        return tx.origin == owner;\n    }\n}\n",
            additional_sources: [
              { file_path: "@openzeppelin/contracts/utils/Address.sol", source_code: "pragma solidity ^0.8.24;\nlibrary Address {\n    function f() internal view returns (bool) {\n        return tx.origin == address(0);\n    }\n}\n" },
              { file_path: "../../../../escape.sol", source_code: "pragma solidity ^0.8.24;\ncontract Escape {}\n" },
              { file_path: "notes.txt", source_code: "not Solidity" },
            ],
          }),
        },
      );
      expect(titles(result)).toEqual([["Gate: Authorization by tx.origin", "high"]]);
      expect(result.findings[0].location).toBe(`${CONTRACT}/src/Gate.sol:6`);
      expect(result.log).toContain("read 2 published source files of its own. Library code it depends on is left out.");
      // Whatever the explorer calls a file, it is written inside the job's own directory.
      expect(await readdir(path.dirname(runDir))).not.toContain("escape.sol");
      expect((await readdir(path.join(runDir, CONTRACT))).sort()).toEqual(["@openzeppelin", "escape.sol", "src"]);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it("looks only at well-formed addresses, and reports a chain it cannot reach as a check that did not happen", async () => {
    const { rpc, calls } = chain({});
    const none = await runChaincheck({ source: { addresses: ["0x1234", "DROP TABLE", 7, null] }, toolVersion: "1" }, { rpc, explorer: async () => null });
    expect(none).toMatchObject({ outcome: "error", error: "The job names no address to look at.", findings: [] });
    expect(calls).toEqual([]);
    const down = await runChaincheck(
      { source: { addresses: [CONTRACT] }, toolVersion: "1" },
      {
        rpc: async () => {
          throw new Error("fetch failed");
        },
        explorer: async () => null,
      },
    );
    expect(down).toMatchObject({ outcome: "error", findings: [] });
    expect(down.error).toBe("GOAT Testnet3 could not be read: fetch failed");
    // No more than ten addresses are read in one job.
    const many = Array.from({ length: 14 }, (_, n) => `0x${String(n + 1).padStart(40, "0")}`);
    const capped = await runChaincheck({ source: { addresses: many }, toolVersion: "1" }, { rpc: chain({}).rpc, explorer: async () => null });
    expect(capped.findings).toHaveLength(10);
  });
});

describe("the Solidity pattern review", () => {
  const GATE = "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\ncontract Gate {\n    address public owner;\n    function open() external view returns (bool) {\n        return tx.origin == owner;\n    }\n}\n";

  it("turns Solhint's report into findings, rating only the rules it knows", () => {
    const findings = parseSolhintReport([
      { filePath: "src/Gate.sol", line: 6, ruleId: "avoid-tx-origin", message: "Avoid to use tx.origin" },
      { filePath: "src/Gate.sol", line: 9, ruleId: "some-new-rule", message: "Something new" },
      { filePath: "src/Broken.sol", ruleId: "", message: "Parse error: mismatched input" },
      null,
      { line: 3 },
    ]);
    expect(findings).toEqual([
      expect.objectContaining({ title: "Authorization by tx.origin", severity: "high", category: "security", location: "src/Gate.sol:6", evidence: "Avoid to use tx.origin\nSolhint rule: avoid-tx-origin" }),
      expect.objectContaining({ title: "Solidity rule: some-new-rule", severity: "low", category: "security", location: "src/Gate.sol:9" }),
      expect.objectContaining({ title: "File could not be read as Solidity: src/Broken.sol", severity: "info", category: "compiler", location: "src/Broken.sol" }),
    ]);
    expect(parseSolhintReport(null)).toEqual([]);
  });

  it.skipIf(!tools.solhint)("reads a project's own Solidity, whatever the project says about how to read it", { timeout: 120_000 }, async () => {
    const runDir = await realpath(await mkdtemp(path.join(tmpdir(), "solhint-")));
    try {
      await mkdir(path.join(runDir, "src"), { recursive: true });
      await mkdir(path.join(runDir, "lib", "forge-std"), { recursive: true });
      await mkdir(path.join(runDir, "node_modules", "@openzeppelin"), { recursive: true });
      await writeFile(path.join(runDir, "src", "Gate.sol"), GATE);
      // The file switches the rule off for itself, and the project switches every rule off.
      await writeFile(path.join(runDir, "src", "Quiet.sol"), `// solhint-disable\n${GATE.replace("Gate", "Quiet").replace("return tx.origin", "/* solhint-disable-next-line avoid-tx-origin */ return tx.origin")}`);
      await writeFile(path.join(runDir, ".solhint.json"), JSON.stringify({ rules: { "avoid-tx-origin": "off" } }));
      await writeFile(path.join(runDir, ".solhintignore"), "src/\n");
      await writeFile(path.join(runDir, "lib", "forge-std", "Vm.sol"), GATE.replace("Gate", "Vm"));
      await writeFile(path.join(runDir, "node_modules", "@openzeppelin", "Ownable.sol"), GATE.replace("Gate", "Ownable"));
      await writeFile(path.join(runDir, "src", "Broken.sol"), "contract Broken { function ( }}}} this is not solidity\n");

      const result = await runSolhint({ runDir, target: ".", timeoutMs: 60_000, toolVersion: tools.solhint });
      expect(result).toMatchObject({ outcome: "failed", tool: "solhint" });
      const flagged = result.findings.filter((f: { title: string }) => f.title === "Authorization by tx.origin").map((f: { location: string }) => f.location);
      expect(flagged.sort()).toEqual(["src/Gate.sol:6", "src/Quiet.sol:7"]);
      // Code the project depends on is not the project's to answer for.
      expect(JSON.stringify(result.findings)).not.toMatch(/forge-std|openzeppelin/);
      // A file that cannot be read is named as such, and does not stop the others being reviewed.
      expect(result.findings.some((f: { title: string; category: string }) => f.title.includes("could not be read as Solidity") && f.category === "compiler")).toBe(true);
      expect(result.log).toContain("Reviewed 3 Solidity files without compiling them.");
      expect(result.log).toContain("pattern review");
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it("reports having nothing to read as a review that did not happen", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "solhint-empty-"));
    try {
      await writeFile(path.join(runDir, "index.ts"), "export {};\n");
      const result = await runSolhint({ runDir, target: ".", timeoutMs: 10_000, toolVersion: "solhint 6" });
      expect(result).toMatchObject({ outcome: "error", error: "There is no Solidity source here for the review to read.", findings: [] });
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

describe("the worker's table of what it will do", () => {
  const every = { vitest: "1", forge: "1", slither: "1", eslint: "1", solhint: "1", webcheck: "1", chaincheck: "1" };

  it("lists a reading only where the tool for it is installed", () => {
    expect(supportedPairs(every)).toEqual(expect.arrayContaining(PAIRS));
    const without = supportedPairs({ ...every, solhint: null });
    expect(without).not.toContain("files:solidity_review");
    expect(without).not.toContain("github:solidity_review");
    expect(without).toContain("contracts:contract_check");
  });

  it("offers only reading for anything a buyer shares, and each reading only for what it reads", () => {
    for (const kind of ["github", "files", "website", "contracts"]) {
      for (const capability of ["unit_testing", "regression_testing", "api_testing", "foundry_unit", "foundry_fuzz", "invariant_testing", "slither_static_analysis", "solidity_compilation"]) {
        expect(planFor(kind, capability), `${kind}:${capability}`).toBeNull();
      }
    }
    expect(planFor("website", "security_scan")).toBeNull();
    expect(planFor("website", "contract_check")).toBeNull();
    expect(planFor("contracts", "website_check")).toBeNull();
    expect(planFor("files", "website_check")).toBeNull();
    expect(planFor("website", "toString")).toBeNull();
    expect(planFor("__proto__", "website_check")).toBeNull();
    // The pattern review is not sold against the bundled vault, whose known weakness it cannot see.
    expect(planFor("sample-solidity-vault", "solidity_review")).toBeNull();
  });

  it.skipIf(!tools.eslint)("scans shared files by reading them, and shows the lines it means", { timeout: 120_000 }, async () => {
    const job = {
      id: randomUUID(),
      fixtureKey: "files",
      capability: "security_scan",
      source: { kind: "files" },
      files: [
        { name: "run.ts", content: "export function run(input: string) {\n  return eval(input);\n}\n" },
        // Names that are not plain file names are never written anywhere.
        { name: "../outside.ts", content: "eval('x');\n" },
        { name: "sub/dir.ts", content: "eval('x');\n" },
        { name: ".eslintrc.js", content: "module.exports = {};\n" },
      ],
    };
    const result = await executeJob(job, tools);
    expect(result).toMatchObject({ outcome: "failed", tool: "eslint" });
    expect(result.findings.map((f: { location: string }) => f.location)).toEqual(["run.ts:2"]);
    expect(result.findings[0].code.lines.join("\n")).toContain("eval(input)");
    expect(result.log).toContain("Read 1 shared file. Nothing in it was run.");
  });

  it("reports files it cannot use as a scan that did not happen", async () => {
    const result = await executeJob(
      { id: randomUUID(), fixtureKey: "files", capability: "security_scan", source: { kind: "files" }, files: [{ name: "../x.ts", content: "x" }, { name: "ok.ts" }] } as never,
      { eslint: "eslint 9" },
    );
    expect(result).toMatchObject({ outcome: "error", findings: [] });
    expect(result.error).toContain("The shared files could not be read");
  });

  it("passes a website or addresses to its reader as data, and needs the reader installed", async () => {
    let given: Record<string, unknown> | null = null;
    const website = { id: randomUUID(), fixtureKey: "website", capability: "website_check", source: { kind: "website", url: "https://www.example.org" } };
    const result = await executeJob(website, { webcheck: "1" }, {
      runWebcheck: async (input: Record<string, unknown>) => {
        given = input;
        return { tool: "webcheck", toolVersion: "1", command: "website check (passive)", exitCode: null, durationMs: 5, log: "Looked.", outcome: "passed", findings: [] };
      },
    });
    expect(given!.source).toEqual(website.source);
    expect(result).toMatchObject({ outcome: "passed", tool: "webcheck", log: "Looked." });
    expect(await executeJob(website, { eslint: "eslint 9" })).toMatchObject({ outcome: "error", error: "webcheck is not installed in this worker." });

    const contracts = { id: randomUUID(), fixtureKey: "contracts", capability: "contract_check", source: { kind: "contracts", addresses: [REGISTRY] } };
    await executeJob(contracts, { chaincheck: "1" }, {
      runChaincheck: async (input: Record<string, unknown>) => {
        given = input;
        return { tool: "chaincheck", toolVersion: "1", command: "", exitCode: null, durationMs: 5, log: "", outcome: "passed", findings: [] };
      },
    });
    expect(given!.source).toEqual(contracts.source);
    // A job cannot pick its own reader: the pairing comes from the worker's table.
    expect(await executeJob({ ...website, capability: "contract_check" }, { webcheck: "1", chaincheck: "1" })).toMatchObject({
      outcome: "error",
      error: "This worker has no way to run that test type against that project.",
    });
  });
});
