CREATE TABLE "goat_flow_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"dapp_order_id" text NOT NULL,
	"order_id" text,
	"token_contract" text NOT NULL,
	"from_address" text NOT NULL,
	"pay_to_address" text,
	"amount_units" numeric(78, 0) NOT NULL,
	"status" text DEFAULT 'creating' NOT NULL,
	"flow_status" text,
	"transaction_hash" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goat_flow_orders_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "goat_flow_orders_dapp_order_id_unique" UNIQUE("dapp_order_id"),
	CONSTRAINT "goat_flow_orders_transaction_hash_unique" UNIQUE("transaction_hash")
);
--> statement-breakpoint
ALTER TABLE "master_wallet_accounts" DROP CONSTRAINT "master_wallet_accounts_org_rail_uq";--> statement-breakpoint
ALTER TABLE "engagement_wallets" ADD COLUMN "custody_ref" text;--> statement-breakpoint
ALTER TABLE "engagements" ADD COLUMN "settlement" text DEFAULT 'simulated' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "funding_authorizations_real_ref_uq" ON "funding_authorizations" USING btree ("provider_ref") WHERE "funding_authorizations"."is_simulated" = false AND "funding_authorizations"."provider_ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "master_wallet_accounts" ADD CONSTRAINT "master_wallet_accounts_org_rail_uq" UNIQUE("organization_id","rail","is_simulated");