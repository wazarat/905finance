CREATE TABLE "platform_wallets" (
	"purpose" text PRIMARY KEY NOT NULL,
	"custody_ref" text NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proof_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'sending' NOT NULL,
	"root" text,
	"record_count" integer DEFAULT 0 NOT NULL,
	"wallet_address" text NOT NULL,
	"tx_hash" text,
	"block_number" bigint,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "proof_batches_status" CHECK ("proof_batches"."status" in ('sending', 'sent', 'confirmed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "proof_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "proof_records_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"engagement_id" uuid,
	"kind" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"document" text NOT NULL,
	"record_hash" text NOT NULL,
	"batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proof_records_entity_uq" UNIQUE("kind","entity_id"),
	CONSTRAINT "proof_records_kind" CHECK ("proof_records"."kind" in ('payment', 'funding', 'return', 'rating', 'verdict'))
);
--> statement-breakpoint
ALTER TABLE "proof_records" ADD CONSTRAINT "proof_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proof_records" ADD CONSTRAINT "proof_records_batch_id_proof_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."proof_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proof_batches_one_sending_uq" ON "proof_batches" USING btree ("status") WHERE "proof_batches"."status" = 'sending';--> statement-breakpoint
CREATE INDEX "proof_records_org_idx" ON "proof_records" USING btree ("organization_id","sequence");--> statement-breakpoint
CREATE INDEX "proof_records_batch_idx" ON "proof_records" USING btree ("batch_id","sequence");