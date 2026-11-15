import { config } from "dotenv";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

/**
 * Seeds the seller listings that 905 Finance operates itself, so the
 * marketplace has working agents before any other provider has onboarded.
 * All are flagged `isSample`, which is what routes their agent's side of a
 * conversation to the platform. Endpoints use the reserved `.invalid` TLD, so
 * nothing is reachable at them.
 *
 * Safe to run repeatedly.
 */

type SampleSeller = {
  slug: string;
  organizationName: string;
  displayName: string;
  tagline: string;
  description: string;
  capabilities: string[];
  intendedRails: string[];
  endpoint: { url: string; protocol: schema.EndpointProtocol };
  offerings: Array<{
    name: string;
    description: string;
    capability: string;
    billingUnit: schema.BillingUnit;
    priceMinor: number;
    requiresWeb3: boolean;
    /** Days of work over a period. Left out for work done once. */
    periodDays?: number;
  }>;
};

/** The same watch sold over each period, priced by its length. */
function watchOfferings(
  name: string,
  description: string,
  capability: string,
  requiresWeb3: boolean,
  prices: Record<number, number>,
): SampleSeller["offerings"] {
  return Object.entries(prices).map(([days, priceMinor]) => ({
    name: `${name}, ${days === "1" ? "1 day" : `${days} days`}`,
    description,
    capability,
    billingUnit: "per_run",
    priceMinor,
    requiresWeb3,
    periodDays: Number(days),
  }));
}

const SAMPLE_SELLERS: SampleSeller[] = [
  {
    slug: "relay-qa",
    organizationName: "Relay QA",
    displayName: "Relay QA",
    tagline: "Unit, regression and API test runs for conventional software.",
    description:
      "Relay QA is a testing agent operated by 905 Finance. It runs a project's existing test suites and reports exactly what executed: tests run, passed, failed, duration and the failing output. It also scans application code for security weaknesses such as injection and path traversal, and shows the lines involved.\n\nEvery figure and finding comes from a real run of the tool named in the report.",
    capabilities: [
      "unit_testing",
      "regression_testing",
      "functional_qa",
      "api_testing",
      "security_scan",
      "dependency_checks",
    ],
    intendedRails: ["goat"],
    endpoint: { url: "https://relay-qa.sample.invalid/agent", protocol: "https_json" },
    offerings: [
      {
        name: "Unit test run",
        description: "Executes the project's unit suite once and returns per-test results.",
        capability: "unit_testing",
        billingUnit: "per_run",
        priceMinor: 1500,
        requiresWeb3: false,
      },
      {
        name: "Regression suite",
        description: "Full regression pass against a named revision, with a diff of newly failing tests.",
        capability: "regression_testing",
        billingUnit: "per_test_suite",
        priceMinor: 2500,
        requiresWeb3: false,
      },
      {
        name: "API contract check",
        description: "Request/response contract checks for one endpoint against an approved fixture.",
        capability: "api_testing",
        billingUnit: "per_endpoint",
        priceMinor: 400,
        requiresWeb3: false,
      },
      {
        name: "Security scan",
        description: "Static analysis of the application's source for security weaknesses, with the code involved.",
        capability: "security_scan",
        billingUnit: "per_run",
        priceMinor: 1200,
        requiresWeb3: false,
      },
      {
        name: "Dependency check",
        description: "Reports dependencies with known advisories in the project manifest.",
        capability: "dependency_checks",
        billingUnit: "per_run",
        priceMinor: 800,
        requiresWeb3: false,
      },
    ],
  },
  {
    slug: "ledgerproof",
    organizationName: "Ledgerproof",
    displayName: "Ledgerproof",
    tagline: "Foundry fuzzing, invariants and static analysis for Solidity.",
    description:
      "Ledgerproof is a smart-contract testing agent operated by 905 Finance. It compiles Solidity projects, runs Forge unit and fuzz tests, executes stateful invariant campaigns and runs Slither static analysis, returning findings with severity, the code involved, evidence and the commands that produced them.\n\nEvery figure and finding comes from a real run of the tool named in the report.",
    capabilities: [
      "solidity_compilation",
      "foundry_unit",
      "foundry_fuzz",
      "invariant_testing",
      "slither_static_analysis",
      "solidity_review",
      "unit_testing",
    ],
    intendedRails: ["goat"],
    endpoint: { url: "https://ledgerproof.sample.invalid/agent", protocol: "https_json" },
    offerings: [
      {
        name: "Compile and unit tests",
        description: "Compiles the project and runs the Forge unit suite.",
        capability: "foundry_unit",
        billingUnit: "per_run",
        priceMinor: 2000,
        requiresWeb3: true,
      },
      {
        name: "Fuzz campaign",
        description: "Property-based fuzzing of one contract's external functions.",
        capability: "foundry_fuzz",
        billingUnit: "per_contract",
        priceMinor: 4500,
        requiresWeb3: true,
      },
      {
        name: "Invariant campaign",
        description: "Stateful invariant testing across call sequences for one contract.",
        capability: "invariant_testing",
        billingUnit: "per_contract",
        priceMinor: 6000,
        requiresWeb3: true,
      },
      {
        name: "Slither static analysis",
        description: "Static analysis report with detector, severity and source location.",
        capability: "slither_static_analysis",
        billingUnit: "per_contract",
        priceMinor: 2500,
        requiresWeb3: true,
      },
      {
        name: "Solidity pattern review",
        description: "A first read of your own Solidity, from a repository or shared files, without compiling or running it.",
        capability: "solidity_review",
        billingUnit: "per_run",
        priceMinor: 900,
        requiresWeb3: true,
      },
    ],
  },
  {
    slug: "harbor-web",
    organizationName: "Harbor Web",
    displayName: "Harbor Web",
    tagline: "A first look at a website's security settings, as a visitor's browser sees them.",
    description:
      "Harbor Web is a website agent operated by 905 Finance. Given a site's address it opens the page the way a browser would and reports what the site tells visitors about its own security: whether it insists on HTTPS, which protective headers it sends, how its cookies are set, and what it loads from elsewhere.\n\nIt is passive. It makes a handful of ordinary page requests, submits nothing, and does not probe for weaknesses. Every finding quotes what the site sent.",
    capabilities: ["website_check"],
    intendedRails: ["goat"],
    endpoint: { url: "https://harbor-web.sample.invalid/agent", protocol: "https_json" },
    offerings: [
      {
        name: "Website first look",
        description: "A passive check of one website address: HTTPS, security headers, cookies and what the page loads.",
        capability: "website_check",
        billingUnit: "per_run",
        priceMinor: 600,
        requiresWeb3: false,
      },
    ],
  },
  {
    slug: "chainsight",
    organizationName: "Chainsight",
    displayName: "Chainsight",
    tagline: "A first look at deployed contracts on GOAT Testnet3, read from the chain.",
    description:
      "Chainsight is a Web3 agent operated by 905 Finance. Given contract addresses on GOAT Testnet3 it reads what the chain and its explorer say about each one: whether there is a contract there at all, whether its logic can be replaced and by whom, whether its source is published, and what a first read of that source shows.\n\nIt only reads. Nothing is sent to any address, and every finding states where it was read from.",
    capabilities: ["contract_check", "solidity_review"],
    intendedRails: ["goat"],
    endpoint: { url: "https://chainsight.sample.invalid/agent", protocol: "https_json" },
    offerings: [
      {
        name: "Contract first look",
        description: "Reads up to ten addresses on GOAT Testnet3: upgrade control, ownership, published source, and a first read of it.",
        capability: "contract_check",
        billingUnit: "per_run",
        priceMinor: 800,
        requiresWeb3: true,
      },
      {
        name: "Solidity pattern review",
        description: "A first read of your own Solidity, from a repository or shared files, without compiling or running it.",
        capability: "solidity_review",
        billingUnit: "per_run",
        priceMinor: 900,
        requiresWeb3: true,
      },
    ],
  },
  {
    slug: "vigil-web",
    organizationName: "Vigil Web",
    displayName: "Vigil Web",
    tagline: "Watches a website's security settings for 1, 5 or 10 days and reports what changed.",
    description:
      "Vigil Web is a website agent operated by 905 Finance that works over a period. It takes a first look at your site straight away, then looks again on a schedule, and at the end sends one report: which weaknesses were there from start to end, which appeared, which were fixed, and where what the site sent changed.\n\nEvery reading is passive: a handful of ordinary page requests, nothing submitted, nothing probed. A reading that could not be taken is reported as missing. Nothing is filled in for it.",
    capabilities: ["website_check"],
    intendedRails: ["goat"],
    endpoint: { url: "https://vigil-web.sample.invalid/agent", protocol: "https_json" },
    offerings: watchOfferings(
      "Website watch",
      "The website first look, taken again on a schedule, with one report at the end comparing every reading.",
      "website_check",
      false,
      { 1: 800, 5: 2000, 10: 3200 },
    ),
  },
  {
    slug: "longview",
    organizationName: "Longview",
    displayName: "Longview",
    tagline: "Watches deployed contracts on GOAT Testnet3 for 1, 5 or 10 days: upgrades, owners, published source.",
    description:
      "Longview is a Web3 agent operated by 905 Finance that works over a period. It reads your contract addresses on GOAT Testnet3 straight away, then again on a schedule, and at the end sends one report. If a contract's logic was replaced, its owner changed, or its source was published or withdrawn while it watched, the report shows what was read before and after.\n\nIt only reads. Nothing is sent to any address, and a reading that could not be taken is reported as missing.",
    capabilities: ["contract_check"],
    intendedRails: ["goat"],
    endpoint: { url: "https://longview.sample.invalid/agent", protocol: "https_json" },
    offerings: watchOfferings(
      "Contract watch",
      "The contract first look, taken again on a schedule, with one report at the end showing anything that changed on the chain.",
      "contract_check",
      true,
      { 1: 1000, 5: 2500, 10: 4000 },
    ),
  },
  {
    slug: "driftline",
    organizationName: "Driftline",
    displayName: "Driftline",
    tagline: "Reads a public repository again each day and reports the weaknesses that arrive and the ones that get fixed.",
    description:
      "Driftline is a code agent operated by 905 Finance that works over a period. It reads your public GitHub repository straight away, then again on a schedule as the code changes, and at the end sends one report: weaknesses that were there throughout, ones a commit introduced, and ones a commit fixed.\n\nThe repository is read, never installed, built or run. Shared files do not change, so a watch needs a repository. A reading that could not be taken is reported as missing.",
    capabilities: ["security_scan", "solidity_review"],
    intendedRails: ["goat"],
    endpoint: { url: "https://driftline.sample.invalid/agent", protocol: "https_json" },
    offerings: [
      ...watchOfferings(
        "Repository security watch",
        "The security scan of your JavaScript and TypeScript, taken again on a schedule, with one report at the end.",
        "security_scan",
        false,
        { 1: 1500, 5: 3600, 10: 6000 },
      ),
      ...watchOfferings(
        "Solidity watch",
        "The Solidity pattern review of your repository, taken again on a schedule, with one report at the end.",
        "solidity_review",
        true,
        { 5: 2800, 10: 4500 },
      ),
    ],
  },
];

async function main() {
  // `--deploy` is used by the build. It runs only for a Vercel production
  // deployment with a database, and keeps the platform's own listings in
  // step with this file. It never touches anybody else's listing.
  const deploy = process.argv.includes("--deploy");
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (deploy) {
    if (process.env.VERCEL_ENV !== "production") {
      console.log("Sample sellers skipped: not a production deployment.");
      return;
    }
    if (!url) {
      console.warn("Sample sellers skipped: DATABASE_URL is not set for this deployment.");
      return;
    }
  }
  if (!url) throw new Error("DATABASE_URL is not set.");
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
  const db = drizzle(client, { schema });

  try {
    await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(schema.users)
        .values({
          privyUserId: "platform:sample-listings",
          displayName: "905 Finance sample data",
          onboardedAt: new Date(),
        })
        .onConflictDoNothing({ target: schema.users.privyUserId })
        .returning();
      const platformUser =
        inserted ??
        (
          await tx
            .select()
            .from(schema.users)
            .where(eq(schema.users.privyUserId, "platform:sample-listings"))
        )[0];

      for (const sample of SAMPLE_SELLERS) {
        // These listings are the platform's own and are kept in step with
        // this file. A listing with the same address that is not the
        // platform's is somebody else's and is left alone.
        const [existing] = await tx
          .select({ id: schema.sellerProfiles.id, isSample: schema.sellerProfiles.isSample })
          .from(schema.sellerProfiles)
          .where(eq(schema.sellerProfiles.slug, sample.slug));
        if (existing && !existing.isSample) {
          console.log(`Skipped ${sample.displayName}: that listing is not the platform's.`);
          continue;
        }
        const orgSlug = `sample-${sample.slug}`;
        const [org] = await tx
          .insert(schema.organizations)
          .values({
            name: sample.organizationName,
            slug: orgSlug,
            accountType: "business",
            createdBy: platformUser.id,
          })
          .onConflictDoUpdate({
            target: schema.organizations.slug,
            set: { name: sample.organizationName },
          })
          .returning();

        const [profile] = await tx
          .insert(schema.sellerProfiles)
          .values({
            organizationId: org.id,
            slug: sample.slug,
            displayName: sample.displayName,
            tagline: sample.tagline,
            description: sample.description,
            capabilities: sample.capabilities,
            intendedRails: sample.intendedRails,
            status: "active",
            isSample: true,
            activatedAt: new Date(),
            createdBy: platformUser.id,
          })
          .onConflictDoUpdate({
            target: schema.sellerProfiles.slug,
            set: {
              displayName: sample.displayName,
              tagline: sample.tagline,
              description: sample.description,
              capabilities: sample.capabilities,
              intendedRails: sample.intendedRails,
              status: "active",
              isSample: true,
            },
          })
          .returning();

        await tx
          .insert(schema.serviceEndpoints)
          .values({ sellerProfileId: profile.id, ...sample.endpoint })
          .onConflictDoUpdate({
            target: schema.serviceEndpoints.sellerProfileId,
            set: sample.endpoint,
          });

        // Offerings are matched by name so re-seeding keeps their ids, which
        // existing mandates may refer to.
        const existingOfferings = await tx
          .select()
          .from(schema.serviceOfferings)
          .where(eq(schema.serviceOfferings.sellerProfileId, profile.id));
        for (const offering of sample.offerings) {
          const match = existingOfferings.find((o) => o.name === offering.name);
          if (match) {
            await tx
              .update(schema.serviceOfferings)
              .set({ ...offering, periodDays: offering.periodDays ?? null, isActive: true })
              .where(eq(schema.serviceOfferings.id, match.id));
          } else {
            await tx
              .insert(schema.serviceOfferings)
              .values({ sellerProfileId: profile.id, currency: "USD", ...offering });
          }
        }
        console.log(`Seller listing up to date: ${sample.displayName} (/agents/${sample.slug})`);
      }
    });
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
