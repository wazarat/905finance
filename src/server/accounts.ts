import "server-only";
import { asc, eq } from "drizzle-orm";
import { getDb, schema, type DbOrTx } from "@/db/client";
import type { BuyerProfile, Organization, OrgRole, SellerProfile, User } from "@/db/schema";
import { slugify } from "@/lib/paths";
import { recordAudit } from "./audit";
import { assertAuthenticated, requirePermission, type Actor } from "./authz";
import { conflict, notFound } from "./errors";
import { onboardingInput, parseInput, roleChoice, type RoleChoice } from "./validation";

const { users, organizations, organizationMemberships, buyerProfiles, sellerProfiles } = schema;

export type Workspace = {
  organization: Organization;
  role: OrgRole;
  buyerProfile: BuyerProfile | null;
  sellerProfile: SellerProfile | null;
};

export type AccountContext = {
  user: User;
  /** The organization the user is working in. Null until onboarding is complete. */
  workspace: Workspace | null;
};

/**
 * Everything the signed-in user's own screens need: their user row and the
 * organization they belong to, with its buyer and seller profiles.
 * The MVP gives each user one organization; the first membership is the workspace.
 */
export async function getAccountContext(actor: Actor | null): Promise<AccountContext> {
  assertAuthenticated(actor);
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, actor.userId));
  if (!user) throw notFound("User");

  const [row] = await db
    .select({ membership: organizationMemberships, organization: organizations })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
    .where(eq(organizationMemberships.userId, actor.userId))
    .orderBy(asc(organizationMemberships.createdAt))
    .limit(1);
  if (!row) return { user, workspace: null };

  const [buyerProfile] = await db
    .select()
    .from(buyerProfiles)
    .where(eq(buyerProfiles.organizationId, row.organization.id));
  const [sellerProfile] = await db
    .select()
    .from(sellerProfiles)
    .where(eq(sellerProfiles.organizationId, row.organization.id));

  return {
    user,
    workspace: {
      organization: row.organization,
      role: row.membership.role,
      buyerProfile: buyerProfile ?? null,
      sellerProfile: sellerProfile ?? null,
    },
  };
}

async function uniqueSlug(
  db: DbOrTx,
  table: typeof organizations | typeof sellerProfiles,
  base: string,
): Promise<string> {
  const root = slugify(base) || "workspace";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate =
      attempt === 0 ? root : `${root}-${crypto.randomUUID().replaceAll("-", "").slice(0, 5)}`;
    const [taken] = await db.select({ id: table.id }).from(table).where(eq(table.slug, candidate));
    if (!taken) return candidate;
  }
  return `${root}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

async function createBuyerProfile(
  db: DbOrTx,
  actor: Actor,
  organization: Organization,
  user: User,
): Promise<BuyerProfile> {
  const [profile] = await db
    .insert(buyerProfiles)
    .values({
      organizationId: organization.id,
      displayName: organization.name,
      contactEmail: user.email,
      createdBy: actor.userId,
    })
    .returning();
  await recordAudit(
    {
      actorUserId: actor.userId,
      organizationId: organization.id,
      action: "buyer_profile.created",
      entityType: "buyer_profile",
      entityId: profile.id,
    },
    db,
  );
  return profile;
}

async function createSellerDraft(
  db: DbOrTx,
  actor: Actor,
  organization: Organization,
  displayName: string,
): Promise<SellerProfile> {
  const [profile] = await db
    .insert(sellerProfiles)
    .values({
      organizationId: organization.id,
      slug: await uniqueSlug(db, sellerProfiles, displayName),
      displayName,
      status: "draft",
      createdBy: actor.userId,
    })
    .returning();
  await recordAudit(
    {
      actorUserId: actor.userId,
      organizationId: organization.id,
      action: "seller_profile.created",
      entityType: "seller_profile",
      entityId: profile.id,
      metadata: { status: "draft" },
    },
    db,
  );
  return profile;
}

/**
 * First-run setup: creates the user's organization (as owner) and the buyer
 * and/or seller profile for the roles they chose, in one transaction.
 */
export async function completeOnboarding(actor: Actor | null, rawInput: unknown): Promise<Workspace> {
  assertAuthenticated(actor);
  const input = parseInput(onboardingInput, rawInput);

  return getDb().transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, actor.userId)).for("update");
    if (!user) throw notFound("User");

    const [existing] = await tx
      .select({ id: organizationMemberships.id })
      .from(organizationMemberships)
      .where(eq(organizationMemberships.userId, actor.userId))
      .limit(1);
    if (existing) {
      throw conflict("You have already set up an organization.");
    }

    const [organization] = await tx
      .insert(organizations)
      .values({
        name: input.organizationName,
        slug: await uniqueSlug(tx, organizations, input.organizationName),
        accountType: input.accountType,
        createdBy: actor.userId,
      })
      .returning();
    await tx.insert(organizationMemberships).values({
      organizationId: organization.id,
      userId: actor.userId,
      role: "owner",
    });
    await recordAudit(
      {
        actorUserId: actor.userId,
        organizationId: organization.id,
        action: "organization.created",
        entityType: "organization",
        entityId: organization.id,
        metadata: { roles: input.roles, accountType: input.accountType },
      },
      tx,
    );

    const wantsBuyer = input.roles === "buyer" || input.roles === "both";
    const wantsSeller = input.roles === "seller" || input.roles === "both";
    const buyerProfile = wantsBuyer ? await createBuyerProfile(tx, actor, organization, user) : null;
    const sellerProfile = wantsSeller
      ? await createSellerDraft(tx, actor, organization, input.sellerDisplayName || organization.name)
      : null;

    await tx
      .update(users)
      .set({ displayName: input.displayName, onboardedAt: new Date() })
      .where(eq(users.id, actor.userId));

    return { organization, role: "owner" as const, buyerProfile, sellerProfile };
  });
}

/** Add the buyer or seller role to an organization that does not have it yet. Owner only. */
export async function enableRole(
  actor: Actor | null,
  organizationId: string,
  rawRole: unknown,
): Promise<void> {
  const role: RoleChoice = parseInput(roleChoice, rawRole);
  await getDb().transaction(async (tx) => {
    await requirePermission(actor, organizationId, "org.enable_role", tx);
    assertAuthenticated(actor);
    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .for("update");
    if (!organization) throw notFound("Organization");
    const [user] = await tx.select().from(users).where(eq(users.id, actor.userId));
    if (!user) throw notFound("User");

    if (role === "buyer" || role === "both") {
      const [has] = await tx
        .select({ id: buyerProfiles.id })
        .from(buyerProfiles)
        .where(eq(buyerProfiles.organizationId, organizationId));
      if (!has) await createBuyerProfile(tx, actor, organization, user);
    }
    if (role === "seller" || role === "both") {
      const [has] = await tx
        .select({ id: sellerProfiles.id })
        .from(sellerProfiles)
        .where(eq(sellerProfiles.organizationId, organizationId));
      if (!has) await createSellerDraft(tx, actor, organization, organization.name);
    }
  });
}
