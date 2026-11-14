import { config } from "dotenv";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

/**
 * Seeds two illustrative seller listings so the marketplace is browsable before
 * any real provider has onboarded. Both are flagged `isSample` and are labelled
 * as samples everywhere they appear. Endpoints use the reserved `.invalid` TLD,
 * so nothing is reachable at them.
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
  }>;
};

const SAMPLE_SELLERS: SampleSeller[] = [
  {
    slug: "relay-qa",
    organizationName: "Relay QA (sample)",
    displayName: "Relay QA",
    tagline: "Unit, regression and API test runs for conventional software.",
    description:
      "Relay QA is an illustrative listing for a testing agent that runs a project's existing test suites and reports exactly what executed: tests run, passed, failed, duration and the failing output. It covers unit and regression suites, functional checks of user-facing flows, and contract tests against approved API fixtures.\n\nThis is sample data provided by 905 Finance to show how a seller listing reads. It is not a real provider: engagements with it are demonstrations in which no one is contacted and no real funds move.",
    capabilities: [
      "unit_testing",
      "regression_testing",
      "functional_qa",
      "api_testing",
      "dependency_checks",
    ],
    intendedRails: ["qatom"],
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
    organizationName: "Ledgerproof (sample)",
    displayName: "Ledgerproof",
    tagline: "Foundry fuzzing, invariants and static analysis for Solidity.",
    description:
      "Ledgerproof is an illustrative listing for a smart-contract testing agent. It compiles Solidity projects, runs Forge unit and fuzz tests, executes stateful invariant campaigns and runs Slither static analysis, returning findings with severity, evidence and the commands that produced them.\n\nThis is sample data provided by 905 Finance to show how a Web3-capable listing reads. It is not a real provider: engagements with it are demonstrations in which no one is contacted and no real funds move.",
    capabilities: [
      "solidity_compilation",
      "foundry_unit",
      "foundry_fuzz",
      "invariant_testing",
      "slither_static_analysis",
      "unit_testing",
    ],
    intendedRails: ["goat", "qatom"],
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
    ],
  },
];

async function main() {
  // `--deploy` is used by the build. It runs only for a Vercel production
  // deployment with a database, and only adds a sample that is missing: it
  // never rewrites a listing that already exists.
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
        if (deploy) {
          const [existing] = await tx
            .select({ id: schema.sellerProfiles.id })
            .from(schema.sellerProfiles)
            .where(eq(schema.sellerProfiles.slug, sample.slug));
          if (existing) {
            console.log(`Sample seller already present: ${sample.displayName}`);
            continue;
          }
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
              .set({ ...offering, isActive: true })
              .where(eq(schema.serviceOfferings.id, match.id));
          } else {
            await tx
              .insert(schema.serviceOfferings)
              .values({ sellerProfileId: profile.id, currency: "USD", ...offering });
          }
        }
        console.log(`Seeded sample seller: ${sample.displayName} (/agents/${sample.slug})`);
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
