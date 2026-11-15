import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Identity, organizations, buyer and seller profiles, service listings and
 * projects (Milestone 1); engagements, spending mandates and the wallet model
 * (Milestone 2); agent runs, purchases, reservations, payments, approvals and
 * agent messages (Milestone 3); testing jobs, results, findings and workers
 * (Milestone 4).
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

/** Payment rails. Funds on one rail are never interchangeable with another. */
export const paymentRail = pgEnum("payment_rail", ["qatom", "goat"]);
export const engagementState = pgEnum("engagement_state", [
  "DISCOVERING",
  "SELLER_SELECTED",
  "AUTHORIZED",
  "WALLET_PROVISIONED",
  "AWAITING_FUNDING",
  "ACTIVE",
  "PAUSED_FOR_APPROVAL",
  "COMPLETED",
  "CANCELLED",
  "EXPIRED",
  "FAILED",
]);
export const mandateStatus = pgEnum("mandate_status", ["draft", "authorized", "revoked"]);
export const walletStatus = pgEnum("wallet_status", [
  "provisioning",
  "awaiting_funding",
  "active",
  "suspended",
  "closing",
  "closed",
]);
export const agentStatus = pgEnum("agent_status", ["inactive", "active", "suspended", "revoked"]);
export const fundingStatus = pgEnum("funding_status", ["authorized", "executed", "failed"]);
export const ledgerEntryKind = pgEnum("ledger_entry_kind", [
  "simulated_deposit",
  "funding_debit",
  "funding_credit",
  "payment_debit",
  "return_debit",
  "return_credit",
]);
export const purchaseStatus = pgEnum("purchase_status", [
  "blocked",
  "reserved",
  "paid",
  "delivered",
  "payment_failed",
  "needs_reconciliation",
]);
export const reservationStatus = pgEnum("reservation_status", ["held", "committed", "released"]);
export const paymentAttemptStatus = pgEnum("payment_attempt_status", [
  "initiated",
  "succeeded",
  "failed",
  "uncertain",
]);
export const approvalKind = pgEnum("approval_kind", ["budget_increase", "additional_funding"]);
export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "modified",
  "cancelled",
]);
export const agentRunStatus = pgEnum("agent_run_status", ["running", "completed", "paused", "failed"]);
export const testingJobStatus = pgEnum("testing_job_status", [
  "queued",
  "running",
  "completed",
  "failed",
]);
/** What the tests found: all passed, something failed, or the run itself could not complete. */
export const testingOutcome = pgEnum("testing_outcome", ["passed", "failed", "error"]);
export const findingSeverity = pgEnum("finding_severity", ["critical", "high", "medium", "low", "info"]);
export const messageDirection = pgEnum("message_direction", [
  "agent_to_seller",
  "seller_to_agent",
  "platform",
]);

/**
 * An amount in an asset's smallest unit, stored exactly. Wide enough for
 * 18-decimal tokens; surfaced to TypeScript as bigint, never as a float.
 */
const units = (name: string) => numeric(name, { precision: 78, scale: 0, mode: "bigint" });

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

/**
 * A seller's ERC-8004 identity on GOAT, as last read from the chain.
 *
 * Nothing in this row is typed in by the seller except the agent id. The
 * owner, the receiving wallet and the registration are what the registry
 * and the registration document said when they were read. `confirmed` is
 * true only when the agent's own registration document points back at this
 * listing, so that a seller cannot dress its listing in another agent's
 * identity or reputation.
 */
export const sellerIdentities = pgTable(
  "seller_identities",
  {
    sellerProfileId: uuid("seller_profile_id")
      .primaryKey()
      .references(() => sellerProfiles.id, { onDelete: "cascade" }),
    /** `eip155:<chain>:<identity registry>`. */
    agentRegistry: text("agent_registry").notNull(),
    agentId: text("agent_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    /** Where the registry says the agent is paid. */
    agentWallet: text("agent_wallet").notNull(),
    agentWalletSet: boolean("agent_wallet_set").notNull().default(false),
    agentUri: text("agent_uri").notNull().default(""),
    registration: jsonb("registration").$type<Record<string, unknown>>(),
    registrationProblem: text("registration_problem"),
    confirmed: boolean("confirmed").notNull().default(false),
    reputationClients: integer("reputation_clients").notNull().default(0),
    reputationCount: integer("reputation_count").notNull().default(0),
    /** The registry's own summary value, as a decimal string. Null when there is no feedback. */
    reputationValue: text("reputation_value"),
    linkedBy: uuid("linked_by").references(() => users.id, { onDelete: "set null" }),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("seller_identities_agent_uq").on(t.agentRegistry, t.agentId)],
);

/**
 * A buying organization's link to the ERC-8004 identity of its buying agent.
 * Read from the registry exactly like a seller's: nothing here is typed in by
 * the organization except the agent id.
 */
export const buyerIdentities = pgTable(
  "buyer_identities",
  {
    buyerProfileId: uuid("buyer_profile_id")
      .primaryKey()
      .references(() => buyerProfiles.id, { onDelete: "cascade" }),
    agentRegistry: text("agent_registry").notNull(),
    agentId: text("agent_id").notNull(),
    ownerAddress: text("owner_address").notNull(),
    agentUri: text("agent_uri").notNull().default(""),
    registration: jsonb("registration").$type<Record<string, unknown>>(),
    registrationProblem: text("registration_problem"),
    confirmed: boolean("confirmed").notNull().default(false),
    linkedBy: uuid("linked_by").references(() => users.id, { onDelete: "set null" }),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("buyer_identities_agent_uq").on(t.agentRegistry, t.agentId)],
);

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
    /** The project's website. For a project of the buyer's own, it can be checked as shared. */
    applicationUrl: text("application_url"),
    /** Contract or account addresses on GOAT Testnet3 the buyer shared, for a Web3 project. */
    contractAddresses: text("contract_addresses").array().notNull().default(sql`'{}'::text[]`),
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
      // 'repository' is a project of the buyer's own: what it shares (a repository, a
      // website, files, addresses) is checked by the application, since files live in
      // their own table. A fixture is a bundled project and nothing else.
      sql`(${t.sourceType} = 'repository' AND ${t.fixtureKey} IS NULL)
        OR (${t.sourceType} = 'fixture' AND ${t.fixtureKey} IS NOT NULL AND ${t.repositoryUrl} IS NULL)`,
    ),
  ],
);

/** Source files a buyer shared with a project, to be read by a scan. Never executed. */
export const projectFiles = pgTable(
  "project_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    content: text("content").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("project_files_name_uq").on(t.projectId, t.name),
    check("project_files_size", sql`${t.bytes} between 1 and 262144`),
  ],
);

// ---------------------------------------------------------------------------
// Engagements
// ---------------------------------------------------------------------------

/**
 * The central commercial object: one buyer organization, one project, one
 * human-selected seller, one payment rail. A database trigger (see the
 * engagement guards migration) makes the organization, project and seller
 * immutable once set, fixes the rail after authorization and makes terminal
 * states final, independently of application code.
 */
export const engagements = pgTable(
  "engagements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    /** Chosen by a person. Null only while DISCOVERING. */
    sellerProfileId: uuid("seller_profile_id").references(() => sellerProfiles.id, {
      onDelete: "restrict",
    }),
    rail: paymentRail("rail"),
    /**
     * Whether this engagement's wallet and payments are simulated or are real
     * ones on GOAT Testnet3. Decided when the mandate is drafted, and fixed
     * once the engagement is authorized.
     */
    settlement: text("settlement").$type<"simulated" | "goat_testnet3">().notNull().default("simulated"),
    state: engagementState("state").notNull().default("DISCOVERING"),
    stateChangedAt: timestamp("state_changed_at", { withTimezone: true }).notNull().defaultNow(),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    authorizedBy: uuid("authorized_by").references(() => users.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("engagements_org_idx").on(t.organizationId, t.createdAt),
    index("engagements_seller_idx").on(t.sellerProfileId),
    /** Target for composite foreign keys that pin a wallet to its engagement's rail. */
    unique("engagements_id_rail_uq").on(t.id, t.rail),
    check(
      "engagements_seller_required",
      sql`${t.state} = 'DISCOVERING' OR ${t.sellerProfileId} IS NOT NULL`,
    ),
    check(
      "engagements_rail_required",
      sql`${t.state} IN ('DISCOVERING', 'SELLER_SELECTED', 'CANCELLED') OR ${t.rail} IS NOT NULL`,
    ),
    check(
      "engagements_authorization_recorded",
      sql`${t.state} IN ('DISCOVERING', 'SELLER_SELECTED', 'CANCELLED')
        OR (${t.authorizedAt} IS NOT NULL AND ${t.authorizedBy} IS NOT NULL AND ${t.expiresAt} IS NOT NULL)`,
    ),
  ],
);

/** Every state change, in order, with who caused it. Null actor means the platform. */
export const engagementEvents = pgTable(
  "engagement_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Strictly increasing, so events written in one transaction keep their order. */
    sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    fromState: engagementState("from_state"),
    toState: engagementState("to_state").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("engagement_events_engagement_idx").on(t.engagementId, t.sequence)],
);

/**
 * What the buyer has authorized the purchasing agent to spend, on what, and
 * until when. A budget is permission, not money: it never moves funds.
 */
export const spendingMandates = pgTable(
  "spending_mandates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .unique()
      .references(() => engagements.id, { onDelete: "cascade" }),
    version: integer("version").notNull().default(1),
    status: mandateStatus("status").notNull().default("draft"),
    /** The only seller this mandate permits payment to. */
    sellerProfileId: uuid("seller_profile_id")
      .notNull()
      .references(() => sellerProfiles.id, { onDelete: "restrict" }),
    asset: text("asset").notNull(),
    assetDecimals: integer("asset_decimals").notNull(),
    totalAuthorizedUnits: units("total_authorized_units").notNull(),
    perTransactionLimitUnits: units("per_transaction_limit_units").notNull(),
    /** Receiving account the seller must be paid at. Set when a rail is really connected. */
    authorizedRecipient: text("authorized_recipient"),
    scope: text("scope").notNull().default(""),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvalRequirements: jsonb("approval_requirements")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }),
    authorizedBy: uuid("authorized_by").references(() => users.id, { onDelete: "restrict" }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("spending_mandates_total_positive", sql`${t.totalAuthorizedUnits} > 0`),
    check("spending_mandates_limit_positive", sql`${t.perTransactionLimitUnits} > 0`),
    check(
      "spending_mandates_limit_within_total",
      sql`${t.perTransactionLimitUnits} <= ${t.totalAuthorizedUnits}`,
    ),
    check(
      "spending_mandates_authorization_recorded",
      sql`${t.status} = 'draft' OR (${t.authorizedAt} IS NOT NULL AND ${t.authorizedBy} IS NOT NULL)`,
    ),
  ],
);

/** The seller's offerings the agent may buy under a mandate. Nothing else is permitted. */
export const mandatePermittedOfferings = pgTable(
  "mandate_permitted_offerings",
  {
    mandateId: uuid("mandate_id")
      .notNull()
      .references(() => spendingMandates.id, { onDelete: "cascade" }),
    serviceOfferingId: uuid("service_offering_id")
      .notNull()
      .references(() => serviceOfferings.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.mandateId, t.serviceOfferingId] })],
);

/** The agent bound to one engagement. It exists inactive and is activated by the platform. */
export const purchasingAgents = pgTable("purchasing_agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  engagementId: uuid("engagement_id")
    .notNull()
    .unique()
    .references(() => engagements.id, { onDelete: "cascade" }),
  status: agentStatus("status").notNull().default("inactive"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Wallets
// ---------------------------------------------------------------------------

/**
 * A buyer organization's funding account on one rail. Agents never spend from
 * it: funds leave only through a human-authorized funding of an engagement wallet.
 */
export const masterWalletAccounts = pgTable(
  "master_wallet_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    rail: paymentRail("rail").notNull(),
    asset: text("asset").notNull(),
    assetDecimals: integer("asset_decimals").notNull(),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref").notNull(),
    balanceUnits: units("balance_units").notNull().default(sql`0`),
    /** True while the account is a platform simulation with no real asset behind it. */
    isSimulated: boolean("is_simulated").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // An organization may have a simulated account and a real one on the same
    // rail. They are separate accounts and are never drawn on together.
    unique("master_wallet_accounts_org_rail_uq").on(t.organizationId, t.rail, t.isSimulated),
    unique("master_wallet_accounts_provider_ref_uq").on(t.provider, t.providerRef),
    unique("master_wallet_accounts_id_rail_uq").on(t.id, t.rail),
    check("master_wallet_accounts_balance_nonnegative", sql`${t.balanceUnits} >= 0`),
  ],
);

/**
 * The dedicated wallet of exactly one engagement. The unique engagement id
 * means an engagement has one wallet; the trigger makes that link permanent,
 * so a wallet can never be handed to another engagement.
 */
export const engagementWallets = pgTable(
  "engagement_wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id").notNull().unique(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    rail: paymentRail("rail").notNull(),
    asset: text("asset").notNull(),
    assetDecimals: integer("asset_decimals").notNull(),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref").notNull(),
    /** The wallet provider's own handle for the key, when the reference above is a chain address. Never shown. */
    custodyRef: text("custody_ref"),
    status: walletStatus("status").notNull().default("provisioning"),
    balanceUnits: units("balance_units").notNull().default(sql`0`),
    isSimulated: boolean("is_simulated").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("engagement_wallets_provider_ref_uq").on(t.provider, t.providerRef),
    unique("engagement_wallets_id_rail_uq").on(t.id, t.rail),
    unique("engagement_wallets_id_engagement_uq").on(t.id, t.engagementId),
    /** The wallet's rail must be its engagement's rail. */
    foreignKey({
      name: "engagement_wallets_engagement_rail_fk",
      columns: [t.engagementId, t.rail],
      foreignColumns: [engagements.id, engagements.rail],
    }).onDelete("restrict"),
    index("engagement_wallets_org_idx").on(t.organizationId),
    check("engagement_wallets_balance_nonnegative", sql`${t.balanceUnits} >= 0`),
  ],
);

/**
 * A person's decision to move a specific amount from a master account into an
 * engagement wallet. The composite foreign keys guarantee, in the database,
 * that the wallet belongs to the named engagement and that the source and
 * destination are on the same rail.
 */
export const fundingAuthorizations = pgTable(
  "funding_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "restrict" }),
    engagementWalletId: uuid("engagement_wallet_id").notNull(),
    masterWalletAccountId: uuid("master_wallet_account_id").notNull(),
    rail: paymentRail("rail").notNull(),
    asset: text("asset").notNull(),
    amountUnits: units("amount_units").notNull(),
    status: fundingStatus("status").notNull().default("authorized"),
    /** Supplied by the client per attempt so a repeated submit cannot fund twice. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    providerRef: text("provider_ref"),
    failureReason: text("failure_reason"),
    isSimulated: boolean("is_simulated").notNull().default(true),
    authorizedBy: uuid("authorized_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull().defaultNow(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "funding_authorizations_wallet_engagement_fk",
      columns: [t.engagementWalletId, t.engagementId],
      foreignColumns: [engagementWallets.id, engagementWallets.engagementId],
    }).onDelete("restrict"),
    foreignKey({
      name: "funding_authorizations_wallet_rail_fk",
      columns: [t.engagementWalletId, t.rail],
      foreignColumns: [engagementWallets.id, engagementWallets.rail],
    }).onDelete("restrict"),
    foreignKey({
      name: "funding_authorizations_master_rail_fk",
      columns: [t.masterWalletAccountId, t.rail],
      foreignColumns: [masterWalletAccounts.id, masterWalletAccounts.rail],
    }).onDelete("restrict"),
    index("funding_authorizations_engagement_idx").on(t.engagementId, t.createdAt),
    // One on-chain transfer funds one authorization, once.
    uniqueIndex("funding_authorizations_real_ref_uq")
      .on(t.providerRef)
      .where(sql`${t.isSimulated} = false AND ${t.providerRef} IS NOT NULL`),
    check("funding_authorizations_amount_positive", sql`${t.amountUnits} > 0`),
  ],
);

/**
 * A person's authorization to send an ended engagement's unused funds back
 * to the account they came from. Funds never move between engagements, and
 * never move at all without this.
 */
export const fundReturns = pgTable(
  "fund_returns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "restrict" }),
    engagementWalletId: uuid("engagement_wallet_id")
      .notNull()
      .references(() => engagementWallets.id, { onDelete: "restrict" }),
    masterWalletAccountId: uuid("master_wallet_account_id")
      .notNull()
      .references(() => masterWalletAccounts.id, { onDelete: "restrict" }),
    asset: text("asset").notNull(),
    amountUnits: units("amount_units").notNull(),
    /** authorized, sent, executed, failed, uncertain. */
    status: text("status").notNull().default("authorized"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    /** For a real return: the transaction hash, saved before waiting on it. */
    providerRef: text("provider_ref"),
    failureReason: text("failure_reason"),
    isSimulated: boolean("is_simulated").notNull().default(true),
    authorizedBy: uuid("authorized_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    authorizedAt: timestamp("authorized_at", { withTimezone: true }).notNull().defaultNow(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
  },
  (t) => [
    index("fund_returns_engagement_idx").on(t.engagementId, t.authorizedAt),
    // At most one return in flight or completed per engagement: a second can
    // only be authorized after the first is known to have failed.
    uniqueIndex("fund_returns_one_live_uq")
      .on(t.engagementId)
      .where(sql`${t.status} <> 'failed'`),
    check("fund_returns_amount_positive", sql`${t.amountUnits} > 0`),
  ],
);

/** Append-only record of every balance change on a master account or engagement wallet. */
export const walletLedgerEntries = pgTable(
  "wallet_ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Strictly increasing, so entries written in one transaction keep their order. */
    sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    rail: paymentRail("rail").notNull(),
    masterWalletAccountId: uuid("master_wallet_account_id").references(
      () => masterWalletAccounts.id,
      { onDelete: "restrict" },
    ),
    engagementWalletId: uuid("engagement_wallet_id").references(() => engagementWallets.id, {
      onDelete: "restrict",
    }),
    kind: ledgerEntryKind("kind").notNull(),
    /** Signed change in the asset's smallest unit. */
    deltaUnits: units("delta_units").notNull(),
    balanceAfterUnits: units("balance_after_units").notNull(),
    fundingAuthorizationId: uuid("funding_authorization_id").references(
      () => fundingAuthorizations.id,
      { onDelete: "restrict" },
    ),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("wallet_ledger_entries_org_idx").on(t.organizationId, t.sequence),
    check(
      "wallet_ledger_entries_one_account",
      sql`(${t.masterWalletAccountId} IS NOT NULL) <> (${t.engagementWalletId} IS NOT NULL)`,
    ),
    check("wallet_ledger_entries_balance_nonnegative", sql`${t.balanceAfterUnits} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Purchasing: agent runs, purchases, reservations and payments
// ---------------------------------------------------------------------------

/** One invocation of an engagement's purchasing agent, started by a person. */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    /** Supplied per attempt so a repeated submit does not start a second run. */
    runKey: text("run_key").notNull().unique(),
    brain: text("brain").notNull(),
    status: agentRunStatus("status").notNull().default("running"),
    summary: text("summary").notNull().default(""),
    purchasesCompleted: integer("purchases_completed").notNull().default(0),
    startedBy: uuid("started_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_runs_engagement_idx").on(t.engagementId, t.startedAt),
    /** At most one run in progress per engagement. */
    uniqueIndex("agent_runs_one_running_uq")
      .on(t.engagementId)
      .where(sql`${t.status} = 'running'`),
  ],
);

/**
 * One request by the agent to buy one service, whatever became of it. Blocked
 * requests are kept too, so everything the agent tried is on record.
 */
export const purchases = pgTable(
  "purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "restrict" }),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    serviceOfferingId: uuid("service_offering_id")
      .notNull()
      .references(() => serviceOfferings.id, { onDelete: "restrict" }),
    offeringName: text("offering_name").notNull(),
    quantity: integer("quantity").notNull().default(1),
    asset: text("asset").notNull(),
    amountUnits: units("amount_units").notNull(),
    /** Where the seller asked to be paid. Compared against the mandate before anything is reserved. */
    recipient: text("recipient").notNull(),
    /** One key per intended purchase: a repeat of the same request can never charge twice. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: purchaseStatus("status").notNull(),
    blockReason: text("block_reason"),
    blockMessage: text("block_message"),
    /** What the seller returned after being paid. */
    delivery: jsonb("delivery").$type<Record<string, unknown>>(),
    isSimulated: boolean("is_simulated").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("purchases_engagement_idx").on(t.engagementId, t.sequence),
    check("purchases_quantity_positive", sql`${t.quantity} > 0`),
    check("purchases_amount_positive", sql`${t.amountUnits} > 0`),
  ],
);

/**
 * Spending capacity set aside for one purchase before any payment is tried.
 * Held and committed reservations both count against the mandate. A database
 * trigger refuses a reservation that would take the total past the budget or
 * a single purchase past the per-purchase limit.
 */
export const spendingReservations = pgTable(
  "spending_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseId: uuid("purchase_id")
      .notNull()
      .unique()
      .references(() => purchases.id, { onDelete: "restrict" }),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "restrict" }),
    mandateId: uuid("mandate_id")
      .notNull()
      .references(() => spendingMandates.id, { onDelete: "restrict" }),
    amountUnits: units("amount_units").notNull(),
    status: reservationStatus("status").notNull().default("held"),
    createdAt: createdAt(),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => [
    index("spending_reservations_engagement_idx").on(t.engagementId, t.status),
    check("spending_reservations_amount_positive", sql`${t.amountUnits} > 0`),
  ],
);

/** One try at paying for a purchase. An uncertain outcome is reconciled, never blindly retried. */
export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseId: uuid("purchase_id")
      .notNull()
      .unique()
      .references(() => purchases.id, { onDelete: "restrict" }),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => spendingReservations.id, { onDelete: "restrict" }),
    engagementId: uuid("engagement_id").notNull(),
    engagementWalletId: uuid("engagement_wallet_id").notNull(),
    rail: paymentRail("rail").notNull(),
    asset: text("asset").notNull(),
    amountUnits: units("amount_units").notNull(),
    recipient: text("recipient").notNull(),
    provider: text("provider").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: paymentAttemptStatus("status").notNull().default("initiated"),
    providerRef: text("provider_ref"),
    failureReason: text("failure_reason"),
    isSimulated: boolean("is_simulated").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** A payment can only be drawn on the wallet of the engagement it is for, on that wallet's rail. */
    foreignKey({
      name: "payment_attempts_wallet_engagement_fk",
      columns: [t.engagementWalletId, t.engagementId],
      foreignColumns: [engagementWallets.id, engagementWallets.engagementId],
    }).onDelete("restrict"),
    foreignKey({
      name: "payment_attempts_wallet_rail_fk",
      columns: [t.engagementWalletId, t.rail],
      foreignColumns: [engagementWallets.id, engagementWallets.rail],
    }).onDelete("restrict"),
    index("payment_attempts_engagement_idx").on(t.engagementId, t.createdAt),
    check("payment_attempts_amount_positive", sql`${t.amountUnits} > 0`),
  ],
);

/** A payment the provider has confirmed. Written only after verification. */
export const paymentTransactions = pgTable(
  "payment_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    paymentAttemptId: uuid("payment_attempt_id")
      .notNull()
      .unique()
      .references(() => paymentAttempts.id, { onDelete: "restrict" }),
    purchaseId: uuid("purchase_id")
      .notNull()
      .unique()
      .references(() => purchases.id, { onDelete: "restrict" }),
    engagementId: uuid("engagement_id").notNull(),
    engagementWalletId: uuid("engagement_wallet_id").notNull(),
    sellerProfileId: uuid("seller_profile_id")
      .notNull()
      .references(() => sellerProfiles.id, { onDelete: "restrict" }),
    rail: paymentRail("rail").notNull(),
    asset: text("asset").notNull(),
    amountUnits: units("amount_units").notNull(),
    recipient: text("recipient").notNull(),
    provider: text("provider").notNull(),
    providerRef: text("provider_ref").notNull(),
    isSimulated: boolean("is_simulated").notNull().default(true),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "payment_transactions_wallet_engagement_fk",
      columns: [t.engagementWalletId, t.engagementId],
      foreignColumns: [engagementWallets.id, engagementWallets.engagementId],
    }).onDelete("restrict"),
    index("payment_transactions_engagement_idx").on(t.engagementId, t.sequence),
    unique("payment_transactions_provider_ref_uq").on(t.provider, t.providerRef),
    check("payment_transactions_amount_positive", sql`${t.amountUnits} > 0`),
  ],
);

/**
 * A request for a person's decision, raised when the agent needs more
 * authority (budget) or more money in its wallet. It records what the
 * situation was at the time so the decision is made on the facts.
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    kind: approvalKind("kind").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    purchaseId: uuid("purchase_id").references(() => purchases.id, { onDelete: "set null" }),
    serviceOfferingId: uuid("service_offering_id").references(() => serviceOfferings.id, {
      onDelete: "set null",
    }),
    offeringName: text("offering_name").notNull(),
    asset: text("asset").notNull(),
    assetDecimals: integer("asset_decimals").notNull(),
    proposedAmountUnits: units("proposed_amount_units").notNull(),
    totalAuthorizedUnits: units("total_authorized_units").notNull(),
    spentUnits: units("spent_units").notNull(),
    reservedUnits: units("reserved_units").notNull(),
    walletBalanceUnits: units("wallet_balance_units").notNull(),
    /** How much more budget, or how much more funding, the proposed purchase needs. */
    shortfallUnits: units("shortfall_units").notNull(),
    explanation: text("explanation").notNull().default(""),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "restrict" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note").notNull().default(""),
    /** The new total budget, when a budget increase was approved. */
    approvedTotalUnits: units("approved_total_units"),
    /** The permitted service the buyer chose instead, when the proposal was modified. */
    replacementOfferingId: uuid("replacement_offering_id").references(() => serviceOfferings.id, {
      onDelete: "set null",
    }),
    replacementUsedAt: timestamp("replacement_used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("approval_requests_engagement_idx").on(t.engagementId, t.sequence),
    /** One open question per engagement at a time. */
    uniqueIndex("approval_requests_one_pending_uq")
      .on(t.engagementId)
      .where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * Everything exchanged between an engagement's agent and its seller, plus the
 * platform's own notes. A database trigger refuses an agent or seller message
 * unless the engagement is ACTIVE and the seller is the one selected for it.
 */
export const agentMessages = pgTable(
  "agent_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    agentRunId: uuid("agent_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    sellerProfileId: uuid("seller_profile_id").references(() => sellerProfiles.id, {
      onDelete: "restrict",
    }),
    direction: messageDirection("direction").notNull(),
    kind: text("kind").notNull(),
    body: jsonb("body").$type<Record<string, unknown>>().notNull().default({}),
    /** What carried the message between the two agents: "in_app" or "qatom". */
    channel: text("channel").notNull().default("in_app"),
    /** The carrier's own reference for the message, such as a Qatom transaction id. */
    channelRef: text("channel_ref"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_messages_engagement_idx").on(t.engagementId, t.sequence),
    check(
      "agent_messages_seller_named",
      sql`${t.direction} = 'platform' OR ${t.sellerProfileId} IS NOT NULL`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Qatom: the channel agents talk through. No money moves through it.
// ---------------------------------------------------------------------------

export const qatomConnectionStatus = pgEnum("qatom_connection_status", ["connected", "needs_reconnect"]);

/**
 * The OAuth client this application registered with Qatom for one redirect
 * address. A public client: it has no secret, and every sign-in uses PKCE.
 */
export const qatomOauthClients = pgTable("qatom_oauth_clients", {
  redirectUri: text("redirect_uri").primaryKey(),
  clientId: text("client_id").notNull(),
  createdAt: createdAt(),
});

/**
 * A buying organization's link to its Qatom account, made by its owner
 * signing in at Qatom. The tokens are stored encrypted and are used for one
 * thing: sending the organization's agents' messages through Qatom.
 */
export const qatomConnections = pgTable("qatom_connections", {
  organizationId: uuid("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  connectedBy: uuid("connected_by")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  clientId: text("client_id").notNull(),
  /** Who signed in at Qatom, as Qatom reports it. Shown so the owner can see which account is linked. */
  subject: text("subject").notNull().default(""),
  email: text("email"),
  primaryTwin: text("primary_twin"),
  agentTwin: text("agent_twin"),
  scope: text("scope").notNull().default(""),
  /** AES-256-GCM ciphertext. Never returned by any query that feeds a page. */
  accessTokenSealed: text("access_token_sealed").notNull(),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }).notNull(),
  refreshTokenSealed: text("refresh_token_sealed"),
  status: qatomConnectionStatus("status").notNull().default("connected"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Every message a seller's endpoint has accepted from Qatom. One row per
 * Qatom transaction and per message nonce, so the same message can never be
 * served twice however many times it is delivered.
 */
export const qatomDispatches = pgTable(
  "qatom_dispatches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Qatom's id for the sale that carried the message. */
    transactionId: text("transaction_id").notNull().unique(),
    sellerProfileId: uuid("seller_profile_id")
      .notNull()
      .references(() => sellerProfiles.id, { onDelete: "cascade" }),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    nonce: text("nonce").notNull(),
    /** True when the sale was confirmed with Qatom itself, not just by the shared header. */
    confirmedWithQatom: boolean("confirmed_with_qatom").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique("qatom_dispatches_nonce_uq").on(t.engagementId, t.nonce)],
);

// ---------------------------------------------------------------------------
// GOAT Flow: one order per payment attempt
// ---------------------------------------------------------------------------

/**
 * A GOAT Flow order created for one payment attempt, and what became of it.
 * The row is written before GOAT Flow is asked for anything, so an attempt
 * whose outcome was lost can be found and reconciled instead of repeated.
 */
export const goatFlowOrders = pgTable("goat_flow_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The payment attempt's key. One order per attempt, ever. */
  idempotencyKey: text("idempotency_key").notNull().unique(),
  /** Our identifier, sent to GOAT Flow. Duplicates are rejected there too. */
  dappOrderId: text("dapp_order_id").notNull().unique(),
  /** GOAT Flow's identifier, once it has answered. */
  orderId: text("order_id"),
  tokenContract: text("token_contract").notNull(),
  fromAddress: text("from_address").notNull(),
  /** Where GOAT Flow said to pay. Compared with the mandate's recipient before anything is sent. */
  payToAddress: text("pay_to_address"),
  amountUnits: units("amount_units").notNull(),
  /** creating, creation_unknown, payable, sent, confirmed, failed. */
  status: text("status").notNull().default("creating"),
  /** GOAT Flow's own status for the order, as last read. */
  flowStatus: text("flow_status"),
  /** The transfer's transaction hash, saved before waiting on it. */
  transactionHash: text("transaction_hash").unique(),
  failureReason: text("failure_reason"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Testing: jobs, results and findings
// ---------------------------------------------------------------------------

/**
 * A test to be executed for one paid purchase. Jobs wait in this table until
 * a testing worker claims one; a claim is a lease that expires, so a worker
 * that dies does not strand a job.
 */
export const testingJobs = pgTable(
  "testing_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    /** One job per purchase: a purchase is never executed twice. */
    purchaseId: uuid("purchase_id")
      .notNull()
      .unique()
      .references(() => purchases.id, { onDelete: "restrict" }),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "restrict" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    sellerProfileId: uuid("seller_profile_id")
      .notNull()
      .references(() => sellerProfiles.id, { onDelete: "restrict" }),
    serviceOfferingId: uuid("service_offering_id")
      .notNull()
      .references(() => serviceOfferings.id, { onDelete: "restrict" }),
    /** The test type. Together with the fixture it selects what the worker runs. */
    capability: text("capability").notNull(),
    /** A bundled project's key, or "github" for a repository the buyer shared. */
    fixtureKey: text("fixture_key").notNull(),
    /** What the buyer shared, for a project of their own. Null for a bundled project. */
    source: jsonb("source").$type<JobSource>(),
    status: testingJobStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("testing_jobs_queue_idx").on(t.status, t.sequence),
    index("testing_jobs_engagement_idx").on(t.engagementId, t.sequence),
  ],
);

/**
 * What a worker reported for a job. Every count is taken from the testing
 * tool's own machine-readable report; counts are null where a tool has no
 * such notion (compilation, static analysis).
 */
export const testingResults = pgTable(
  "testing_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .unique()
      .references(() => testingJobs.id, { onDelete: "cascade" }),
    outcome: testingOutcome("outcome").notNull(),
    testsTotal: integer("tests_total"),
    testsPassed: integer("tests_passed"),
    testsFailed: integer("tests_failed"),
    testsSkipped: integer("tests_skipped"),
    durationMs: integer("duration_ms").notNull(),
    tool: text("tool").notNull(),
    toolVersion: text("tool_version").notNull().default(""),
    /** The command the worker ran, for the record. */
    command: text("command").notNull().default(""),
    exitCode: integer("exit_code"),
    /** The tool's output, kept as evidence. */
    log: text("log").notNull().default(""),
    errorMessage: text("error_message"),
    workerId: text("worker_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "testing_results_counts_consistent",
      sql`${t.testsTotal} IS NULL OR (
        ${t.testsTotal} >= 0 AND ${t.testsPassed} >= 0 AND ${t.testsFailed} >= 0 AND ${t.testsSkipped} >= 0
        AND ${t.testsPassed} + ${t.testsFailed} + ${t.testsSkipped} = ${t.testsTotal}
      )`,
    ),
    check("testing_results_duration_nonnegative", sql`${t.durationMs} >= 0`),
  ],
);

/** One thing a job found: a failing test, a violated property, or a static-analysis result. */
export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => testingJobs.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    severity: findingSeverity("severity").notNull(),
    /** test_failure, static_analysis, compiler or security. */
    category: text("category").notNull(),
    location: text("location").notNull().default(""),
    evidence: text("evidence").notNull().default(""),
    recommendation: text("recommendation").notNull().default(""),
    /** The source lines the finding points at, as the worker read them from the project. */
    code: jsonb("code").$type<FindingCode>(),
    createdAt: createdAt(),
  },
  (t) => [index("findings_job_idx").on(t.jobId, t.sequence)],
);

/**
 * What a job is run on when it is not a bundled project. A repository travels
 * as an owner and a name; files are attached when a worker claims the job.
 */
export type JobSource =
  | { kind: "github"; owner: string; repo: string }
  | { kind: "files" }
  | { kind: "website"; url: string }
  | { kind: "contracts"; addresses: string[] };

export type FindingCode = {
  file: string;
  startLine: number;
  highlightStart: number;
  highlightEnd: number;
  lines: string[];
};

/** Testing workers that have checked in, and what each can run. */
export const testingWorkers = pgTable("testing_workers", {
  workerId: text("worker_id").primaryKey(),
  tools: jsonb("tools").$type<Record<string, string | null>>().notNull().default({}),
  /** "fixture:capability" pairs the worker reported it can execute. */
  supports: text("supports").array().notNull().default(sql`'{}'::text[]`),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

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

// ---------------------------------------------------------------------------
// Reputation and validation
// ---------------------------------------------------------------------------

/**
 * A buyer's rating of the seller for one engagement, from one to five stars.
 * One per engagement, and never edited: a rating is a statement made at a
 * point in time.
 */
export const engagementRatings = pgTable(
  "engagement_ratings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .unique()
      .references(() => engagements.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sellerProfileId: uuid("seller_profile_id")
      .notNull()
      .references(() => sellerProfiles.id, { onDelete: "cascade" }),
    stars: integer("stars").notNull(),
    comment: text("comment").notNull().default(""),
    ratedBy: uuid("rated_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** The ERC-8004 ids of the two agents, when each had a confirmed identity at the time. */
    buyerAgentId: text("buyer_agent_id"),
    sellerAgentId: text("seller_agent_id"),
    /** The hash of the public feedback document, as written to the registry. */
    feedbackHash: text("feedback_hash").notNull(),
    /**
     * platform: kept by 905 Finance only. sending, sent, confirmed, failed,
     * uncertain: the progress of writing it to the Reputation Registry.
     */
    chainStatus: text("chain_status").notNull().default("platform"),
    /** The transaction that wrote it to the registry. */
    chainRef: text("chain_ref"),
    chainProblem: text("chain_problem"),
    createdAt: createdAt(),
  },
  (t) => [
    index("engagement_ratings_seller_idx").on(t.sellerProfileId, t.createdAt),
    check("engagement_ratings_stars_range", sql`${t.stars} between 1 and 5`),
    check(
      "engagement_ratings_chain_status",
      sql`${t.chainStatus} in ('platform', 'sending', 'sent', 'confirmed', 'failed', 'uncertain')`,
    ),
  ],
);

/**
 * A problem with an engagement, put to 905 Finance to validate. Opened by the
 * buyer, or by a rating of one or two stars. Decided by a 905 Finance
 * operator who belongs to neither side.
 */
export const validationCases = pgTable(
  "validation_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sellerProfileId: uuid("seller_profile_id")
      .notNull()
      .references(() => sellerProfiles.id, { onDelete: "cascade" }),
    ratingId: uuid("rating_id").references(() => engagementRatings.id, { onDelete: "set null" }),
    /** low_rating or reported. */
    origin: text("origin").notNull(),
    reason: text("reason").notNull(),
    openedBy: uuid("opened_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    sellerResponse: text("seller_response"),
    sellerRespondedBy: uuid("seller_responded_by").references(() => users.id, { onDelete: "set null" }),
    sellerRespondedAt: timestamp("seller_responded_at", { withTimezone: true }),
    /** open, upheld (the buyer's complaint stands) or not_upheld. */
    status: text("status").notNull().default("open"),
    /** The validator's score for the seller's work, 0 to 100, as ERC-8004 expresses a validation. */
    score: integer("score"),
    verdictNote: text("verdict_note"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** The hash of what was put to the validator, fixed when the case is opened. */
    requestHash: text("request_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("validation_cases_status_idx").on(t.status, t.createdAt),
    index("validation_cases_seller_idx").on(t.sellerProfileId, t.createdAt),
    // One case at a time per engagement.
    uniqueIndex("validation_cases_one_open_uq")
      .on(t.engagementId)
      .where(sql`${t.status} = 'open'`),
    check("validation_cases_origin", sql`${t.origin} in ('low_rating', 'reported')`),
    check("validation_cases_status", sql`${t.status} in ('open', 'upheld', 'not_upheld')`),
    check("validation_cases_score_range", sql`${t.score} is null or ${t.score} between 0 and 100`),
    check(
      "validation_cases_decided_together",
      sql`(${t.status} = 'open') = (${t.decidedAt} is null) and (${t.status} = 'open') = (${t.score} is null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Proof on GOAT
// ---------------------------------------------------------------------------

/** A wallet the platform itself holds through its custody provider, by what it is for. */
export const platformWallets = pgTable("platform_wallets", {
  purpose: text("purpose").primaryKey(),
  custodyRef: text("custody_ref").notNull(),
  address: text("address").notNull(),
  createdAt: createdAt(),
});

/**
 * One transaction on GOAT Testnet3 carrying the combined fingerprint of a
 * group of records. Writing a fingerprint moves nothing and can safely be
 * repeated, so a batch that fails simply releases its records to the next.
 */
export const proofBatches = pgTable(
  "proof_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** sending, sent, confirmed or failed. */
    status: text("status").notNull().default("sending"),
    /** keccak256 of the member records' fingerprints, in order. Set once the members are fixed. */
    root: text("root"),
    recordCount: integer("record_count").notNull().default(0),
    walletAddress: text("wallet_address").notNull(),
    txHash: text("tx_hash"),
    blockNumber: bigint("block_number", { mode: "bigint" }),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (t) => [
    // One batch is put together at a time, so two are never sent from the same wallet at once.
    uniqueIndex("proof_batches_one_sending_uq")
      .on(t.status)
      .where(sql`${t.status} = 'sending'`),
    check("proof_batches_status", sql`${t.status} in ('sending', 'sent', 'confirmed', 'failed')`),
  ],
);

/**
 * The fingerprint of one record: a payment, a funding, a return, a rating or
 * a verdict. `document` is the exact text that was hashed, so anyone holding
 * it can compute the fingerprint again.
 */
export const proofRecords = pgTable(
  "proof_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sequence: bigint("sequence", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    engagementId: uuid("engagement_id"),
    /** payment, funding, return, rating or verdict. */
    kind: text("kind").notNull(),
    entityId: uuid("entity_id").notNull(),
    document: text("document").notNull(),
    recordHash: text("record_hash").notNull(),
    batchId: uuid("batch_id").references(() => proofBatches.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("proof_records_entity_uq").on(t.kind, t.entityId),
    index("proof_records_org_idx").on(t.organizationId, t.sequence),
    index("proof_records_batch_idx").on(t.batchId, t.sequence),
    check("proof_records_kind", sql`${t.kind} in ('payment', 'funding', 'return', 'rating', 'verdict', 'report')`),
  ],
);

export type User = typeof users.$inferSelect;
export type Organization = typeof organizations.$inferSelect;
export type OrganizationMembership = typeof organizationMemberships.$inferSelect;
export type BuyerProfile = typeof buyerProfiles.$inferSelect;
export type SellerProfile = typeof sellerProfiles.$inferSelect;
export type ServiceOffering = typeof serviceOfferings.$inferSelect;
export type ServiceEndpoint = typeof serviceEndpoints.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type AuditEvent = typeof auditEvents.$inferSelect;
export type Engagement = typeof engagements.$inferSelect;
export type EngagementEvent = typeof engagementEvents.$inferSelect;
export type SpendingMandate = typeof spendingMandates.$inferSelect;
export type PurchasingAgent = typeof purchasingAgents.$inferSelect;
export type MasterWalletAccount = typeof masterWalletAccounts.$inferSelect;
export type EngagementWallet = typeof engagementWallets.$inferSelect;
export type FundingAuthorization = typeof fundingAuthorizations.$inferSelect;
export type WalletLedgerEntry = typeof walletLedgerEntries.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type Purchase = typeof purchases.$inferSelect;
export type SpendingReservation = typeof spendingReservations.$inferSelect;
export type PaymentAttempt = typeof paymentAttempts.$inferSelect;
export type PaymentTransaction = typeof paymentTransactions.$inferSelect;
export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type AgentMessage = typeof agentMessages.$inferSelect;
export type QatomConnection = typeof qatomConnections.$inferSelect;
export type SellerIdentity = typeof sellerIdentities.$inferSelect;
export type BuyerIdentity = typeof buyerIdentities.$inferSelect;
export type EngagementRating = typeof engagementRatings.$inferSelect;
export type ValidationCase = typeof validationCases.$inferSelect;
export type ProjectFile = typeof projectFiles.$inferSelect;
export type ProofRecord = typeof proofRecords.$inferSelect;
export type ProofBatch = typeof proofBatches.$inferSelect;
export type FundReturn = typeof fundReturns.$inferSelect;
export type GoatFlowOrder = typeof goatFlowOrders.$inferSelect;
export type Settlement = "simulated" | "goat_testnet3";
export type TestingJob = typeof testingJobs.$inferSelect;
export type TestingResult = typeof testingResults.$inferSelect;
export type Finding = typeof findings.$inferSelect;

export type OrgRole = (typeof orgRole.enumValues)[number];
export type ListingStatus = (typeof listingStatus.enumValues)[number];
export type BillingUnit = (typeof billingUnit.enumValues)[number];
export type EndpointProtocol = (typeof endpointProtocol.enumValues)[number];
export type PaymentRail = (typeof paymentRail.enumValues)[number];
export type EngagementState = (typeof engagementState.enumValues)[number];
export type WalletStatus = (typeof walletStatus.enumValues)[number];
export type MandateStatus = (typeof mandateStatus.enumValues)[number];
export type AgentStatus = (typeof agentStatus.enumValues)[number];
export type PurchaseStatus = (typeof purchaseStatus.enumValues)[number];
export type ApprovalKind = (typeof approvalKind.enumValues)[number];
export type ApprovalStatus = (typeof approvalStatus.enumValues)[number];
export type MessageDirection = (typeof messageDirection.enumValues)[number];
export type TestingJobStatus = (typeof testingJobStatus.enumValues)[number];
export type TestingOutcome = (typeof testingOutcome.enumValues)[number];
export type FindingSeverity = (typeof findingSeverity.enumValues)[number];
