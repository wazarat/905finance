import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

/**
 * Applies pending migrations.
 *
 *   pnpm db:migrate          apply to the database in DATABASE_URL
 *   ... --deploy             used by the build: applies only for a Vercel
 *                            production deployment that has a database
 *                            configured, and is a no-op everywhere else
 *
 * A direct (unpooled) connection is preferred when the host provides one.
 */
async function main() {
  const deploy = process.argv.includes("--deploy");
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

  if (deploy) {
    if (process.env.VERCEL_ENV !== "production") {
      console.log("Migrations skipped: not a production deployment.");
      return;
    }
    if (!url) {
      console.warn("Migrations skipped: DATABASE_URL is not set for this deployment.");
      return;
    }
  }
  if (!url) {
    throw new Error("DATABASE_URL is not set.");
  }

  const client = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });
  try {
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
    console.log("Migrations applied.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
