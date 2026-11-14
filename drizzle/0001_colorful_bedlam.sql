CREATE TYPE "public"."agent_status" AS ENUM('inactive', 'active', 'suspended', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."engagement_state" AS ENUM('DISCOVERING', 'SELLER_SELECTED', 'AUTHORIZED', 'WALLET_PROVISIONED', 'AWAITING_FUNDING', 'ACTIVE', 'PAUSED_FOR_APPROVAL', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."funding_status" AS ENUM('authorized', 'executed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_kind" AS ENUM('simulated_deposit', 'funding_debit', 'funding_credit');--> statement-breakpoint
CREATE TYPE "public"."mandate_status" AS ENUM('draft', 'authorized', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."payment_rail" AS ENUM('qatom', 'goat');--> statement-breakpoint
CREATE TYPE "public"."wallet_status" AS ENUM('provisioning', 'awaiting_funding', 'active', 'suspended', 'closing', 'closed');--> statement-breakpoint
CREATE TABLE "engagement_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"from_state" "engagement_state",
	"to_state" "engagement_state" NOT NULL,
	"actor_user_id" uuid,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "engagement_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"rail" "payment_rail" NOT NULL,
	"asset" text NOT NULL,
	"asset_decimals" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"status" "wallet_status" DEFAULT 'provisioning' NOT NULL,
	"balance_units" numeric(78, 0) DEFAULT 0 NOT NULL,
	"is_simulated" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagement_wallets_engagement_id_unique" UNIQUE("engagement_id"),
	CONSTRAINT "engagement_wallets_provider_ref_uq" UNIQUE("provider","provider_ref"),
	CONSTRAINT "engagement_wallets_id_rail_uq" UNIQUE("id","rail"),
	CONSTRAINT "engagement_wallets_id_engagement_uq" UNIQUE("id","engagement_id"),
	CONSTRAINT "engagement_wallets_balance_nonnegative" CHECK ("engagement_wallets"."balance_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "engagements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"seller_profile_id" uuid,
	"rail" "payment_rail",
	"state" "engagement_state" DEFAULT 'DISCOVERING' NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"authorized_at" timestamp with time zone,
	"authorized_by" uuid,
	"expires_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagements_id_rail_uq" UNIQUE("id","rail"),
	CONSTRAINT "engagements_seller_required" CHECK ("engagements"."state" = 'DISCOVERING' OR "engagements"."seller_profile_id" IS NOT NULL),
	CONSTRAINT "engagements_rail_required" CHECK ("engagements"."state" IN ('DISCOVERING', 'SELLER_SELECTED', 'CANCELLED') OR "engagements"."rail" IS NOT NULL),
	CONSTRAINT "engagements_authorization_recorded" CHECK ("engagements"."state" IN ('DISCOVERING', 'SELLER_SELECTED', 'CANCELLED')
        OR ("engagements"."authorized_at" IS NOT NULL AND "engagements"."authorized_by" IS NOT NULL AND "engagements"."expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "funding_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"engagement_wallet_id" uuid NOT NULL,
	"master_wallet_account_id" uuid NOT NULL,
	"rail" "payment_rail" NOT NULL,
	"asset" text NOT NULL,
	"amount_units" numeric(78, 0) NOT NULL,
	"status" "funding_status" DEFAULT 'authorized' NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_ref" text,
	"failure_reason" text,
	"is_simulated" boolean DEFAULT true NOT NULL,
	"authorized_by" uuid NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funding_authorizations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "funding_authorizations_amount_positive" CHECK ("funding_authorizations"."amount_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "mandate_permitted_offerings" (
	"mandate_id" uuid NOT NULL,
	"service_offering_id" uuid NOT NULL,
	CONSTRAINT "mandate_permitted_offerings_mandate_id_service_offering_id_pk" PRIMARY KEY("mandate_id","service_offering_id")
);
--> statement-breakpoint
CREATE TABLE "master_wallet_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"rail" "payment_rail" NOT NULL,
	"asset" text NOT NULL,
	"asset_decimals" integer NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"balance_units" numeric(78, 0) DEFAULT 0 NOT NULL,
	"is_simulated" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_wallet_accounts_org_rail_uq" UNIQUE("organization_id","rail"),
	CONSTRAINT "master_wallet_accounts_provider_ref_uq" UNIQUE("provider","provider_ref"),
	CONSTRAINT "master_wallet_accounts_id_rail_uq" UNIQUE("id","rail"),
	CONSTRAINT "master_wallet_accounts_balance_nonnegative" CHECK ("master_wallet_accounts"."balance_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purchasing_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"status" "agent_status" DEFAULT 'inactive' NOT NULL,
	"activated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchasing_agents_engagement_id_unique" UNIQUE("engagement_id")
);
--> statement-breakpoint
CREATE TABLE "spending_mandates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "mandate_status" DEFAULT 'draft' NOT NULL,
	"seller_profile_id" uuid NOT NULL,
	"asset" text NOT NULL,
	"asset_decimals" integer NOT NULL,
	"total_authorized_units" numeric(78, 0) NOT NULL,
	"per_transaction_limit_units" numeric(78, 0) NOT NULL,
	"authorized_recipient" text,
	"scope" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approval_requirements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"authorized_at" timestamp with time zone,
	"authorized_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spending_mandates_engagement_id_unique" UNIQUE("engagement_id"),
	CONSTRAINT "spending_mandates_total_positive" CHECK ("spending_mandates"."total_authorized_units" > 0),
	CONSTRAINT "spending_mandates_limit_positive" CHECK ("spending_mandates"."per_transaction_limit_units" > 0),
	CONSTRAINT "spending_mandates_limit_within_total" CHECK ("spending_mandates"."per_transaction_limit_units" <= "spending_mandates"."total_authorized_units"),
	CONSTRAINT "spending_mandates_authorization_recorded" CHECK ("spending_mandates"."status" = 'draft' OR ("spending_mandates"."authorized_at" IS NOT NULL AND "spending_mandates"."authorized_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"rail" "payment_rail" NOT NULL,
	"master_wallet_account_id" uuid,
	"engagement_wallet_id" uuid,
	"kind" "ledger_entry_kind" NOT NULL,
	"delta_units" numeric(78, 0) NOT NULL,
	"balance_after_units" numeric(78, 0) NOT NULL,
	"funding_authorization_id" uuid,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_ledger_entries_one_account" CHECK (("wallet_ledger_entries"."master_wallet_account_id" IS NOT NULL) <> ("wallet_ledger_entries"."engagement_wallet_id" IS NOT NULL)),
	CONSTRAINT "wallet_ledger_entries_balance_nonnegative" CHECK ("wallet_ledger_entries"."balance_after_units" >= 0)
);
--> statement-breakpoint
ALTER TABLE "engagement_events" ADD CONSTRAINT "engagement_events_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_events" ADD CONSTRAINT "engagement_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_wallets" ADD CONSTRAINT "engagement_wallets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_wallets" ADD CONSTRAINT "engagement_wallets_engagement_rail_fk" FOREIGN KEY ("engagement_id","rail") REFERENCES "public"."engagements"("id","rail") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_seller_profile_id_seller_profiles_id_fk" FOREIGN KEY ("seller_profile_id") REFERENCES "public"."seller_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagements" ADD CONSTRAINT "engagements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_authorizations" ADD CONSTRAINT "funding_authorizations_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_authorizations" ADD CONSTRAINT "funding_authorizations_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_authorizations" ADD CONSTRAINT "funding_authorizations_wallet_engagement_fk" FOREIGN KEY ("engagement_wallet_id","engagement_id") REFERENCES "public"."engagement_wallets"("id","engagement_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_authorizations" ADD CONSTRAINT "funding_authorizations_wallet_rail_fk" FOREIGN KEY ("engagement_wallet_id","rail") REFERENCES "public"."engagement_wallets"("id","rail") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_authorizations" ADD CONSTRAINT "funding_authorizations_master_rail_fk" FOREIGN KEY ("master_wallet_account_id","rail") REFERENCES "public"."master_wallet_accounts"("id","rail") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_permitted_offerings" ADD CONSTRAINT "mandate_permitted_offerings_mandate_id_spending_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."spending_mandates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandate_permitted_offerings" ADD CONSTRAINT "mandate_permitted_offerings_service_offering_id_service_offerings_id_fk" FOREIGN KEY ("service_offering_id") REFERENCES "public"."service_offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_wallet_accounts" ADD CONSTRAINT "master_wallet_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_agents" ADD CONSTRAINT "purchasing_agents_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_mandates" ADD CONSTRAINT "spending_mandates_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_mandates" ADD CONSTRAINT "spending_mandates_seller_profile_id_seller_profiles_id_fk" FOREIGN KEY ("seller_profile_id") REFERENCES "public"."seller_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_mandates" ADD CONSTRAINT "spending_mandates_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_mandates" ADD CONSTRAINT "spending_mandates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_master_wallet_account_id_master_wallet_accounts_id_fk" FOREIGN KEY ("master_wallet_account_id") REFERENCES "public"."master_wallet_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_engagement_wallet_id_engagement_wallets_id_fk" FOREIGN KEY ("engagement_wallet_id") REFERENCES "public"."engagement_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_funding_authorization_id_funding_authorizations_id_fk" FOREIGN KEY ("funding_authorization_id") REFERENCES "public"."funding_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engagement_events_engagement_idx" ON "engagement_events" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "engagement_wallets_org_idx" ON "engagement_wallets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "engagements_org_idx" ON "engagements" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "engagements_seller_idx" ON "engagements" USING btree ("seller_profile_id");--> statement-breakpoint
CREATE INDEX "funding_authorizations_engagement_idx" ON "funding_authorizations" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "wallet_ledger_entries_org_idx" ON "wallet_ledger_entries" USING btree ("organization_id","created_at");