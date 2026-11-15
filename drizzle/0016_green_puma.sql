CREATE TABLE "project_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_files_name_uq" UNIQUE("project_id","name"),
	CONSTRAINT "project_files_size" CHECK ("project_files"."bytes" between 1 and 262144)
);
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT "projects_source_present";--> statement-breakpoint
ALTER TABLE "proof_records" DROP CONSTRAINT "proof_records_kind";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "contract_addresses" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_source_present" CHECK (("projects"."source_type" = 'repository' AND "projects"."fixture_key" IS NULL)
        OR ("projects"."source_type" = 'fixture' AND "projects"."fixture_key" IS NOT NULL AND "projects"."repository_url" IS NULL));--> statement-breakpoint
ALTER TABLE "proof_records" ADD CONSTRAINT "proof_records_kind" CHECK ("proof_records"."kind" in ('payment', 'funding', 'return', 'rating', 'verdict', 'report'));