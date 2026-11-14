CREATE TYPE "public"."finding_severity" AS ENUM('critical', 'high', 'medium', 'low', 'info');--> statement-breakpoint
CREATE TYPE "public"."testing_job_status" AS ENUM('queued', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."testing_outcome" AS ENUM('passed', 'failed', 'error');--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "findings_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job_id" uuid NOT NULL,
	"title" text NOT NULL,
	"severity" "finding_severity" NOT NULL,
	"category" text NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"recommendation" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "testing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "testing_jobs_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"purchase_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"seller_profile_id" uuid NOT NULL,
	"service_offering_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"fixture_key" text NOT NULL,
	"status" "testing_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "testing_jobs_purchase_id_unique" UNIQUE("purchase_id")
);
--> statement-breakpoint
CREATE TABLE "testing_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"outcome" "testing_outcome" NOT NULL,
	"tests_total" integer,
	"tests_passed" integer,
	"tests_failed" integer,
	"tests_skipped" integer,
	"duration_ms" integer NOT NULL,
	"tool" text NOT NULL,
	"tool_version" text DEFAULT '' NOT NULL,
	"command" text DEFAULT '' NOT NULL,
	"exit_code" integer,
	"log" text DEFAULT '' NOT NULL,
	"error_message" text,
	"worker_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "testing_results_job_id_unique" UNIQUE("job_id"),
	CONSTRAINT "testing_results_counts_consistent" CHECK ("testing_results"."tests_total" IS NULL OR (
        "testing_results"."tests_total" >= 0 AND "testing_results"."tests_passed" >= 0 AND "testing_results"."tests_failed" >= 0 AND "testing_results"."tests_skipped" >= 0
        AND "testing_results"."tests_passed" + "testing_results"."tests_failed" + "testing_results"."tests_skipped" = "testing_results"."tests_total"
      )),
	CONSTRAINT "testing_results_duration_nonnegative" CHECK ("testing_results"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "testing_workers" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"tools" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"supports" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_job_id_testing_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."testing_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_jobs" ADD CONSTRAINT "testing_jobs_purchase_id_purchases_id_fk" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_jobs" ADD CONSTRAINT "testing_jobs_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_jobs" ADD CONSTRAINT "testing_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_jobs" ADD CONSTRAINT "testing_jobs_seller_profile_id_seller_profiles_id_fk" FOREIGN KEY ("seller_profile_id") REFERENCES "public"."seller_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_jobs" ADD CONSTRAINT "testing_jobs_service_offering_id_service_offerings_id_fk" FOREIGN KEY ("service_offering_id") REFERENCES "public"."service_offerings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "testing_results" ADD CONSTRAINT "testing_results_job_id_testing_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."testing_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "findings_job_idx" ON "findings" USING btree ("job_id","sequence");--> statement-breakpoint
CREATE INDEX "testing_jobs_queue_idx" ON "testing_jobs" USING btree ("status","sequence");--> statement-breakpoint
CREATE INDEX "testing_jobs_engagement_idx" ON "testing_jobs" USING btree ("engagement_id","sequence");