import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema, type DbOrTx } from "@/db/client";
import type { OrgRole, OrganizationMembership } from "@/db/schema";
import { forbidden, notFound, unauthenticated } from "./errors";

/** The verified user a request is acting as. Built only from a verified session. */
export type Actor = { readonly userId: string };

/**
 * What each organization role may do. Financial permissions (funding, limits,
 * approvals, payouts) are owner-only and are added with the milestones that
 * introduce those actions.
 */
export const PERMISSIONS = {
  "org.update": ["owner"],
  "org.enable_role": ["owner"],
  "project.view": ["owner", "admin", "member"],
  "project.create": ["owner", "admin", "member"],
  "project.update": ["owner", "admin"],
  "project.delete": ["owner", "admin"],
  "seller_listing.view": ["owner", "admin", "member"],
  "seller_listing.manage": ["owner", "admin"],
  "seller_listing.submit": ["owner", "admin"],
  "engagement.view": ["owner", "admin", "member"],
  /** Create an engagement and prepare its mandate. Nothing is authorized by drafting. */
  "engagement.draft": ["owner", "admin"],
  "engagement.authorize": ["owner"],
  "engagement.fund": ["owner"],
  "engagement.terminate": ["owner"],
  /** Start the purchasing agent. It can only act inside the mandate the owner authorized. */
  "engagement.operate": ["owner", "admin"],
  /** Decide a budget increase or other approval request. */
  "engagement.approve": ["owner"],
  "wallet.view": ["owner", "admin", "member"],
  "wallet.manage": ["owner"],
} as const satisfies Record<string, readonly OrgRole[]>;

export type Permission = keyof typeof PERMISSIONS;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function assertAuthenticated(actor: Actor | null | undefined): asserts actor is Actor {
  if (!actor || !isUuid(actor.userId)) {
    throw unauthenticated();
  }
}

export function roleHasPermission(role: OrgRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly OrgRole[]).includes(role);
}

export async function findMembership(
  userId: string,
  organizationId: string,
  db: DbOrTx = getDb(),
): Promise<OrganizationMembership | null> {
  if (!isUuid(organizationId)) return null;
  const [membership] = await db
    .select()
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.userId, userId),
        eq(schema.organizationMemberships.organizationId, organizationId),
      ),
    );
  return membership ?? null;
}

/**
 * Authorize an action on an organization the caller named directly.
 * Non-members are refused without revealing whether the organization exists.
 */
export async function requirePermission(
  actor: Actor | null | undefined,
  organizationId: string,
  permission: Permission,
  db: DbOrTx = getDb(),
): Promise<OrganizationMembership> {
  assertAuthenticated(actor);
  const membership = await findMembership(actor.userId, organizationId, db);
  if (!membership) {
    throw forbidden("You are not a member of this organization.");
  }
  if (!roleHasPermission(membership.role, permission)) {
    throw forbidden();
  }
  return membership;
}

/**
 * Authorize an action on a record looked up by its own id. A record in an
 * organization the caller does not belong to is reported as not found.
 */
export async function requirePermissionOnRecord(
  actor: Actor | null | undefined,
  record: { organizationId: string } | undefined | null,
  permission: Permission,
  what: string,
  db: DbOrTx = getDb(),
): Promise<OrganizationMembership> {
  assertAuthenticated(actor);
  if (!record) throw notFound(what);
  const membership = await findMembership(actor.userId, record.organizationId, db);
  if (!membership) throw notFound(what);
  if (!roleHasPermission(membership.role, permission)) throw forbidden();
  return membership;
}
