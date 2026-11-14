import "server-only";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * Driver-agnostic database handle. The app uses postgres.js; the test suite
 * swaps in an in-process PGlite instance through `setDb`.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

const globalForDb = globalThis as unknown as { __nofDb?: Db };

function createDb(): Db {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  }
  const client = postgres(url, { max: 10, prepare: false });
  return drizzle(client, { schema });
}

export function getDb(): Db {
  if (!globalForDb.__nofDb) {
    globalForDb.__nofDb = createDb();
  }
  return globalForDb.__nofDb;
}

/** Test hook: replace the database handle. */
export function setDb(db: Db | undefined): void {
  globalForDb.__nofDb = db;
}

export { schema };
