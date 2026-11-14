DROP INDEX "engagement_events_engagement_idx";--> statement-breakpoint
DROP INDEX "wallet_ledger_entries_org_idx";--> statement-breakpoint
ALTER TABLE "engagement_events" ADD COLUMN "sequence" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "engagement_events_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
ALTER TABLE "wallet_ledger_entries" ADD COLUMN "sequence" bigint NOT NULL GENERATED ALWAYS AS IDENTITY (sequence name "wallet_ledger_entries_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
CREATE INDEX "engagement_events_engagement_idx" ON "engagement_events" USING btree ("engagement_id","sequence");--> statement-breakpoint
CREATE INDEX "wallet_ledger_entries_org_idx" ON "wallet_ledger_entries" USING btree ("organization_id","sequence");