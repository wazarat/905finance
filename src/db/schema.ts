import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Milestone 1 schema: identity, organizations, buyer and seller profiles,
 * service listings and projects.
 *
 * Engagements, wallets, mandates, payments, testing jobs and the rest of the
 * commercial model are introduced by the milestones that implement them.
 */

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const orgRole = pgEnum("org_role", ["owner", "admin", "member"]);
export const accountType = pgEnum("account_type", ["individual", "business"]);
export const listingStatus = pgEnum("listing_status", [
  "draft",
  "pending_review",
  "active",
  "suspended",
]);
export const billingUnit = pgEnum("billing_unit", [
  "per_run",
  "per_test_suite",
  "per_contract",
  "per_endpoint",
  "per_1k_loc",
  "per_hour",
]);
export const endpointProtocol = pgEnum("endpoint_protocol", ["https_json", "mcp", "a2a"]);
export const projectSourceType = pgEnum("project_source_type", ["repository", "fixture"]);

// ---------------------------------------------------------------------------
// Identity and organizations
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Verified identity-provider subject. The only link between a login and this row. */
  privyUserId: text("privy_user_id").notNull().unique(),
  email: text("email"),
  displayName: text("display_name"),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  accountType: accountType("account_type").notNull().default("business"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: orgRole("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("organization_memberships_org_user_uq").on(t.organizationId, t.userId),
    index("organization_memberships_user_idx").on(t.userId),
  ],
);

// ---------------------------------------------------------------------------
// Buyer and seller profiles
// ---------------------------------------------------------------------------

export const buyerProfiles = pgTable("buyer_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** One buyer profile per organization. */
  organizationId: uuid("organization_id")
    .notNull()
    .unique()
    .references(() => organizations.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  contactEmail: text("contact_email"),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sellerProfiles = pgTable(
  "seller_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** One seller listing per organization in the MVP. */
    organizationId: uuid("organization_id")
      .notNull()
      .unique()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(),
    displayName: text("display_name").notNull(),
    tagline: text("tagline").notNull().default(""),
    description: text("description").notNull().default(""),
    /** Capability keys. Known keys are described in src/lib/capabilities.ts. */
    capabilities: text("capabilities").array().notNull().default(sql`'{}'::text[]`),
    /** Rails the seller intends to accept. Informational until a rail is connected. */
    intendedRails: text("intended_rails").array().notNull().default(sql`'{}'::text[]`),
    status: listingStatus("status").notNull().default("draft"),
    /** Illustrative listing seeded by the platform, never a real provider. */
    isSample: boolean("is_sample").notNull().default(false),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("seller_profiles_status_idx").on(t.status)],
);

export const serviceOfferings = pgTable(
  "service_offerings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sellerProfileId: uuid("seller_profile_id")
      .notNull()
      .references(() => sellerProfiles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** Service family. "software_testing" today; other digital services later. */
    category: text("category").notNull().default("software_testing"),
    /** Capability key this offering delivers. */
    capability: text("capability").notNull(),
    billingUnit: billingUnit("billing_unit").notNull(),
    /** Price per billing unit in integer minor units (cents for USD). Never a float. */
    priceMinor: integer("price_minor").notNull(),
    currency: text("currency").notNull().default("USD"),
    requiresWeb3: boolean("requires_web3").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("service_offerings_seller_idx").on(t.sellerProfileId),
    check("service_offerings_price_nonnegative", sql`${t.priceMinor} >= 0`),
    check("service_offerings_currency_format", sql`${t.currency} ~ '^[A-Z]{3,5}$'`),
  ],
);

/**
 * Where a seller's agent is reached. Private: never returned by public queries.
 * Credentials are not stored here; they arrive with the integrations that need them.
 */
export const serviceEndpoints = pgTable("service_endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** One endpoint per seller listing in the MVP. */
  sellerProfileId: uuid("seller_profile_id")
    .notNull()
    .unique()
    .references(() => sellerProfiles.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  protocol: endpointProtocol("protocol").notNull().default("https_json"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    sourceType: projectSourceType("source_type").notNull(),
    repositoryUrl: text("repository_url"),
    fixtureKey: text("fixture_key"),
    applicationUrl: text("application_url"),
    testingObjectives: text("testing_objectives").notNull().default(""),
    /** Configures which testing capabilities apply. It does not fork the workflow. */
    hasWeb3: boolean("has_web3").notNull(),
    /** Explicit confirmation that the creator is entitled to have this target tested. */
    testingAuthorizedAt: timestamp("testing_authorized_at", { withTimezone: true }).notNull(),
    testingAuthorizedBy: uuid("testing_authorized_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("projects_org_idx").on(t.organizationId),
    check(
      "projects_source_present",
      sql`(${t.sourceType} = 'repository' AND ${t.repositoryUrl} IS NOT NULL AND ${t.fixtureKey} IS NULL)
        OR (${t.sourceType} = 'fixture' AND ${t.fixtureKey} IS NOT NULL AND ${t.repositoryUrl} IS NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_events_org_idx").on(t.organizationId, t.createdAt),
    index("audit_events_actor_idx").on(t.actorUserId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type OrganizationMembership = typeof organizationMemberships.$inferSelect;
export type BuyerProfile = typeof buyerProfiles.$inferSelect;
export type SellerProfile = typeof sellerProfiles.$inferSelect;
export type ServiceOffering = typeof serviceOfferings.$inferSelect;
export type ServiceEndpoint = typeof serviceEndpoints.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;

export type OrgRole = (typeof orgRole.enumValues)[number];
export type ListingStatus = (typeof listingStatus.enumValues)[number];
export type BillingUnit = (typeof billingUnit.enumValues)[number];
export type EndpointProtocol = (typeof endpointProtocol.enumValues)[number];
