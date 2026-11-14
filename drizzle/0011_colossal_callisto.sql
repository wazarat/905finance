ALTER TYPE "public"."ledger_entry_kind" ADD VALUE 'return_debit';--> statement-breakpoint
ALTER TYPE "public"."ledger_entry_kind" ADD VALUE 'return_credit';--> statement-breakpoint
CREATE TABLE "fund_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"engagement_wallet_id" uuid NOT NULL,
	"master_wallet_account_id" uuid NOT NULL,
	"asset" text NOT NULL,
	"amount_units" numeric(78, 0) NOT NULL,
	"status" text DEFAULT 'authorized' NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_ref" text,
	"failure_reason" text,
	"is_simulated" boolean DEFAULT true NOT NULL,
	"authorized_by" uuid NOT NULL,
	"authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	CONSTRAINT "fund_returns_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "fund_returns_amount_positive" CHECK ("fund_returns"."amount_units" > 0)
);
--> statement-breakpoint
ALTER TABLE "fund_returns" ADD CONSTRAINT "fund_returns_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_returns" ADD CONSTRAINT "fund_returns_engagement_wallet_id_engagement_wallets_id_fk" FOREIGN KEY ("engagement_wallet_id") REFERENCES "public"."engagement_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_returns" ADD CONSTRAINT "fund_returns_master_wallet_account_id_master_wallet_accounts_id_fk" FOREIGN KEY ("master_wallet_account_id") REFERENCES "public"."master_wallet_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fund_returns" ADD CONSTRAINT "fund_returns_authorized_by_users_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fund_returns_engagement_idx" ON "fund_returns" USING btree ("engagement_id","authorized_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fund_returns_one_live_uq" ON "fund_returns" USING btree ("engagement_id") WHERE "fund_returns"."status" <> 'failed';