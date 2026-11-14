import "server-only";
import { getDb, schema, type DbOrTx } from "@/db/client";

export type AuditInput = {
  actorUserId: string | null;
  organizationId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

/** Append an audit record. Pass the transaction so it commits with the change it describes. */
export async function recordAudit(input: AuditInput, db: DbOrTx = getDb()): Promise<void> {
  await db.insert(schema.auditEvents).values({
    actorUserId: input.actorUserId,
    organizationId: input.organizationId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    metadata: input.metadata ?? {},
  });
}
