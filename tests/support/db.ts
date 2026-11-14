import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { setDb, type Db } from "@/db/client";
import * as schema from "@/db/schema";
import type { Actor } from "@/server/authz";

/**
 * Starts an in-process Postgres, applies the real migrations and installs it
 * as the application's database handle. Each test file gets its own instance.
 */
export async function useTestDatabase(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
  setDb(db as unknown as Db);
  return {
    db: db as unknown as Db,
    close: async () => {
      setDb(undefined);
      await client.close();
    },
  };
}

let counter = 0;

/** Insert a user directly, as a verified sign-in would, and return its actor. */
export async function createUser(db: Db, label = "user"): Promise<Actor & { email: string }> {
  counter += 1;
  const email = `${label}-${counter}@example.test`;
  const [user] = await db
    .insert(schema.users)
    .values({ privyUserId: `test:${label}:${counter}`, email })
    .returning();
  return { userId: user.id, email };
}

export async function addMember(
  db: Db,
  organizationId: string,
  userId: string,
  role: schema.OrgRole,
): Promise<void> {
  await db.insert(schema.organizationMemberships).values({ organizationId, userId, role });
}

export const validProject = {
  name: "Payments API",
  description: "Core payments service",
  sourceType: "repository",
  repositoryUrl: "https://github.com/example/payments-api",
  testingObjectives: "Catch regressions before release",
  hasWeb3: false,
  testingAuthorized: true,
} as const;

export const validOffering = {
  name: "Unit test run",
  description: "Runs the unit suite once",
  capability: "unit_testing",
  billingUnit: "per_run",
  priceMinor: 1500,
} as const;

export const validListing = {
  displayName: "Acme Test Agents",
  tagline: "Tests on demand",
  description: "Runs unit and regression suites and reports exactly what executed.",
  capabilities: ["unit_testing", "regression_testing"],
  intendedRails: ["qatom"],
} as const;

export const validEndpoint = {
  url: "https://agent.acme.example/api",
  protocol: "https_json",
} as const;
