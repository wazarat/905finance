CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'completed', 'paused', 'failed');--> statement-breakpoint
CREATE TYPE "public"."approval_kind" AS ENUM('budget_increase', 'additional_funding');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'modified', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('agent_to_seller', 'seller_to_agent', 'platform');--> statement-breakpoint
CREATE TYPE "public"."payment_attempt_status" AS ENUM('initiated', 'succeeded', 'failed', 'uncertain');--> statement-breakpoint
CREATE TYPE "public"."purchase_status" AS ENUM('blocked', 'reserved', 'paid', 'delivered', 'payment_failed', 'needs_reconciliation');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('held', 'committed', 'released');--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_kind" ADD VALUE 'payment_debit';--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "agent_messages_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"engagement_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"seller_profile_id" uuid,
	"direction" "message_direction" NOT NULL,
	"kind" text NOT NULL,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_messages_seller_named" CHECK ("agent_messages"."direction" = 'platform' OR "agent_messages"."seller_profile_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"run_key" text NOT NULL,
	"brain" text NOT NULL,
	"status" "agent_run_status" DEFAULT 'running' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"purchases_completed" integer DEFAULT 0 NOT NULL,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_runs_run_key_unique" UNIQUE("run_key")
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "approval_requests_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"engagement_id" uuid NOT NULL,
	"kind" "approval_kind" NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"purchase_id" uuid,
	"service_offering_id" uuid,
	"offering_name" text NOT NULL,
	"asset" text NOT NULL,
	"asset_decimals" integer NOT NULL,
	"proposed_amount_units" numeric(78, 0) NOT NULL,
	"total_authorized_units" numeric(78, 0) NOT NULL,
	"spent_units" numeric(78, 0) NOT NULL,
	"reserved_units" numeric(78, 0) NOT NULL,
	"wallet_balance_units" numeric(78, 0) NOT NULL,
	"shortfall_units" numeric(78, 0) NOT NULL,
	"explanation" text DEFAULT '' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text DEFAULT '' NOT NULL,
	"approved_total_units" numeric(78, 0),
	"replacement_offering_id" uuid,
	"replacement_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"engagement_wallet_id" uuid NOT NULL,
	"rail" "payment_rail" NOT NULL,
	"asset" text NOT NULL,
	"amount_units" numeric(78, 0) NOT NULL,
	"recipient" text NOT NULL,
	"provider" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "payment_attempt_status" DEFAULT 'initiated' NOT NULL,
	"provider_ref" text,
	"failure_reason" text,
	"is_simulated" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_attempts_purchase_id_unique" UNIQUE("purchase_id"),
	CONSTRAINT "payment_attempts_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "payment_attempts_amount_positive" CHECK ("payment_attempts"."amount_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "payment_transactions_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"payment_attempt_id" uuid NOT NULL,
	"purchase_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"engagement_wallet_id" uuid NOT NULL,
	"seller_profile_id" uuid NOT NULL,
	"rail" "payment_rail" NOT NULL,
	"asset" text NOT NULL,
	"amount_units" numeric(78, 0) NOT NULL,
	"recipient" text NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text NOT NULL,
	"is_simulated" boolean DEFAULT true NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_transactions_payment_attempt_id_unique" UNIQUE("payment_attempt_id"),
	CONSTRAINT "payment_transactions_purchase_id_unique" UNIQUE("purchase_id"),
	CONSTRAINT "payment_transactions_provider_ref_uq" UNIQUE("provider","provider_ref"),
	CONSTRAINT "payment_transactions_amount_positive" CHECK ("payment_transactions"."amount_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "purchases_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"engagement_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"service_offering_id" uuid NOT NULL,
	"offering_name" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"asset" text NOT NULL,
	"amount_units" numeric(78, 0) NOT NULL,
	"recipient" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "purchase_status" NOT NULL,
	"block_reason" text,
	"block_message" text,
	"delivery" jsonb,
	"is_simulated" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchases_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "purchases_quantity_positive" CHECK ("purchases"."quantity" > 0),
	CONSTRAINT "purchases_amount_positive" CHECK ("purchases"."amount_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "spending_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"mandate_id" uuid NOT NULL,
	"amount_units" numeric(78, 0) NOT NULL,
	"status" "reservation_status" DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "spending_reservations_purchase_id_unique" UNIQUE("purchase_id"),
	CONSTRAINT "spending_reservations_amount_positive" CHECK ("spending_reservations"."amount_units" > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_seller_profile_id_seller_profiles_id_fk" FOREIGN KEY ("seller_profile_id") REFERENCES "public"."seller_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_service_offering_id_service_offerings_id_fk" FOREIGN KEY ("service_offering_id") REFERENCES "public"."service_offerings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_replacement_offering_id_service_offerings_id_fk" FOREIGN KEY ("replacement_offering_id") REFERENCES "public"."service_offerings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_reservation_id_spending_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."spending_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_wallet_engagement_fk" FOREIGN KEY ("engagement_wallet_id","engagement_id") REFERENCES "public"."engagement_wallets"("id","engagement_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_wallet_rail_fk" FOREIGN KEY ("engagement_wallet_id","rail") REFERENCES "public"."engagement_wallets"("id","rail") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_payment_attempt_id_payment_attempts_id_fk" FOREIGN KEY ("payment_attempt_id") REFERENCES "public"."payment_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_seller_profile_id_seller_profiles_id_fk" FOREIGN KEY ("seller_profile_id") REFERENCES "public"."seller_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_wallet_engagement_fk" FOREIGN KEY ("engagement_wallet_id","engagement_id") REFERENCES "public"."engagement_wallets"("id","engagement_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_service_offering_id_service_offerings_id_fk" FOREIGN KEY ("service_offering_id") REFERENCES "public"."service_offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_reservations" ADD CONSTRAINT "spending_reservations_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_reservations" ADD CONSTRAINT "spending_reservations_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_reservations" ADD CONSTRAINT "spending_reservations_mandate_id_spending_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."spending_mandates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_messages_engagement_idx" ON "agent_messages" USING btree ("engagement_id","sequence");--> statement-breakpoint
CREATE INDEX "agent_runs_engagement_idx" ON "agent_runs" USING btree ("engagement_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_running_uq" ON "agent_runs" USING btree ("engagement_id") WHERE "agent_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "approval_requests_engagement_idx" ON "approval_requests" USING btree ("engagement_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_one_pending_uq" ON "approval_requests" USING btree ("engagement_id") WHERE "approval_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "payment_attempts_engagement_idx" ON "payment_attempts" USING btree ("engagement_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_transactions_engagement_idx" ON "payment_transactions" USING btree ("engagement_id","sequence");--> statement-breakpoint
CREATE INDEX "purchases_engagement_idx" ON "purchases" USING btree ("engagement_id","sequence");--> statement-breakpoint
CREATE INDEX "spending_reservations_engagement_idx" ON "spending_reservations" USING btree ("engagement_id","status");