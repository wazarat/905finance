import "server-only";
import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db/client";
import { requirePermission, type Actor } from "./authz";

const { auditEvents, users } = schema;

export type AuditLine = {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  /** Who did it, or null for something the platform did by itself. */
  actorName: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

/**
 * The organization's record of sensitive actions, newest first: who
 * authorized, funded, approved, linked or ended what, and when. It is
 * append-only; nothing in the application edits or deletes an entry.
 */
export async function listAuditEvents(
  actor: Actor | null,
  organizationId: string,
  options: { limit?: number } = {},
): Promise<AuditLine[]> {
  await requirePermission(actor, organizationId, "audit.view");
  const rows = await getDb()
    .select({ event: auditEvents, actorName: users.displayName, actorEmail: users.email })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(eq(auditEvents.organizationId, organizationId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(Math.min(options.limit ?? 200, 500));
  return rows.map(({ event, actorName, actorEmail }) => ({
    id: event.id,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId,
    actorName: event.actorUserId ? (actorName ?? actorEmail ?? "A member") : null,
    metadata: event.metadata,
    createdAt: event.createdAt,
  }));
}
