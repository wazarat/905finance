CREATE TABLE "watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "watches_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"purchase_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"seller_profile_id" uuid NOT NULL,
	"service_offering_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"fixture_key" text NOT NULL,
	"source" jsonb NOT NULL,
	"period_days" integer NOT NULL,
	"every_hours" integer NOT NULL,
	"readings_planned" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'watching' NOT NULL,
	"finished_at" timestamp with time zone,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watches_purchase_id_unique" UNIQUE("purchase_id"),
	CONSTRAINT "watches_status" CHECK ("watches"."status" in ('watching', 'reported', 'failed')),
	CONSTRAINT "watches_plan" CHECK ("watches"."readings_planned" >= 2 and "watches"."every_hours" > 0 and "watches"."period_days" > 0),
	CONSTRAINT "watches_finished_together" CHECK (("watches"."status" = 'watching') = ("watches"."finished_at" is null))
);
--> statement-breakpoint
ALTER TABLE "testing_jobs" DROP CONSTRAINT "testing_jobs_purchase_id_unique";--> statement-breakpoint
ALTER TABLE "proof_records" DROP CONSTRAINT "proof_records_kind";--> statement-breakpoint
ALTER TABLE "service_offerings" ADD COLUMN "period_days" integer;--> statement-breakpoint
ALTER TABLE "testing_jobs" ADD COLUMN "watch_id" uuid;--> statement-breakpoint
ALTER TABLE "testing_jobs" ADD COLUMN "reading" integer;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_seller_profile_id_seller_profiles_id_fk" FOREIGN KEY ("seller_profile_id") REFERENCES "public"."seller_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watches" ADD CONSTRAINT "watches_service_offering_id_service_offerings_id_fk" FOREIGN KEY ("service_offering_id") REFERENCES "public"."service_offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watches_status_idx" ON "watches" USING btree ("status","sequence");--> statement-breakpoint
CREATE INDEX "watches_engagement_idx" ON "watches" USING btree ("engagement_id","sequence");--> statement-breakpoint
ALTER TABLE "testing_jobs" ADD CONSTRAINT "testing_jobs_watch_id_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."watches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "testing_jobs_purchase_once_uq" ON "testing_jobs" USING btree ("purchase_id") WHERE "testing_jobs"."watch_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "testing_jobs_reading_uq" ON "testing_jobs" USING btree ("watch_id","reading") WHERE "testing_jobs"."watch_id" is not null;--> statement-breakpoint
ALTER TABLE "proof_records" ADD CONSTRAINT "proof_records_kind" CHECK ("proof_records"."kind" in ('payment', 'funding', 'return', 'rating', 'verdict', 'report', 'period'));--> statement-breakpoint
ALTER TABLE "service_offerings" ADD CONSTRAINT "service_offerings_period" CHECK ("service_offerings"."period_days" is null or "service_offerings"."period_days" between 1 and 30);--> statement-breakpoint
ALTER TABLE "testing_jobs" ADD CONSTRAINT "testing_jobs_reading_with_watch" CHECK (("testing_jobs"."watch_id" is null) = ("testing_jobs"."reading" is null));--> statement-breakpoint
ALTER TABLE "testing_jobs" ADD CONSTRAINT "testing_jobs_reading_nonnegative" CHECK ("testing_jobs"."reading" is null or "testing_jobs"."reading" >= 0);