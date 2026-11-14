import { config } from "dotenv";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../src/db/schema";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

/**
 * Platform operation: activate a seller listing that is awaiting review.
 *
 *   pnpm seller:activate <slug>
 *
 * Sellers cannot activate their own listings from the application. Until an
 * admin review screen exists, a platform operator runs this after checking the
 * submission. The change is written to the audit log.
 */
async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: pnpm seller:activate <slug>");
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(schema.sellerProfiles)
        .set({ status: "active", activatedAt: new Date() })
        .where(
          and(
            eq(schema.sellerProfiles.slug, slug),
            eq(schema.sellerProfiles.status, "pending_review"),
          ),
        )
        .returning();
      if (!updated) {
        throw new Error(`No listing with slug "${slug}" is awaiting review.`);
      }
      await tx.insert(schema.auditEvents).values({
        actorUserId: null,
        organizationId: updated.organizationId,
        action: "seller_profile.activated",
        entityType: "seller_profile",
        entityId: updated.id,
        metadata: { from: "pending_review", to: "active", via: "platform_cli" },
      });
      console.log(`Activated ${updated.displayName} -> /agents/${updated.slug}`);
    });
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
