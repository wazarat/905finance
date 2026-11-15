CREATE TABLE "buyer_identities" (
	"buyer_profile_id" uuid PRIMARY KEY NOT NULL,
	"agent_registry" text NOT NULL,
	"agent_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"agent_uri" text DEFAULT '' NOT NULL,
	"registration" jsonb,
	"registration_problem" text,
	"confirmed" boolean DEFAULT false NOT NULL,
	"linked_by" uuid,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buyer_identities_agent_uq" UNIQUE("agent_registry","agent_id")
);
--> statement-breakpoint
CREATE TABLE "engagement_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"seller_profile_id" uuid NOT NULL,
	"stars" integer NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"rated_by" uuid NOT NULL,
	"buyer_agent_id" text,
	"seller_agent_id" text,
	"feedback_hash" text NOT NULL,
	"chain_status" text DEFAULT 'platform' NOT NULL,
	"chain_ref" text,
	"chain_problem" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "engagement_ratings_engagement_id_unique" UNIQUE("engagement_id"),
	CONSTRAINT "engagement_ratings_stars_range" CHECK ("engagement_ratings"."stars" between 1 and 5),
	CONSTRAINT "engagement_ratings_chain_status" CHECK ("engagement_ratings"."chain_status" in ('platform', 'sending', 'sent', 'confirmed', 'failed', 'uncertain'))
);
--> statement-breakpoint
CREATE TABLE "validation_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"engagement_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"seller_profile_id" uuid NOT NULL,
	"rating_id" uuid,
	"origin" text NOT NULL,
	"reason" text NOT NULL,
	"opened_by" uuid NOT NULL,
	"seller_response" text,
	"seller_responded_by" uuid,
	"seller_responded_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"score" integer,
	"verdict_note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "validation_cases_origin" CHECK ("validation_cases"."origin" in ('low_rating', 'reported')),
	CONSTRAINT "validation_cases_status" CHECK ("validation_cases"."status" in ('open', 'upheld', 'not_upheld')),
	CONSTRAINT "validation_cases_score_range" CHECK ("validation_cases"."score" is null or "validation_cases"."score" between 0 and 100),
	CONSTRAINT "validation_cases_decided_together" CHECK (("validation_cases"."status" = 'open') = ("validation_cases"."decided_at" is null) and ("validation_cases"."status" = 'open') = ("validation_cases"."score" is null))
);
--> statement-breakpoint
ALTER TABLE "buyer_identities" ADD CONSTRAINT "buyer_identities_buyer_profile_id_buyer_profiles_id_fk" FOREIGN KEY ("buyer_profile_id") REFERENCES "public"."buyer_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buyer_identities" ADD CONSTRAINT "buyer_identities_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_ratings" ADD CONSTRAINT "engagement_ratings_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_ratings" ADD CONSTRAINT "engagement_ratings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_ratings" ADD CONSTRAINT "engagement_ratings_seller_profile_id_seller_profiles_id_fk" FOREIGN KEY ("seller_profile_id") REFERENCES "public"."seller_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engagement_ratings" ADD CONSTRAINT "engagement_ratings_rated_by_users_id_fk" FOREIGN KEY ("rated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_cases" ADD CONSTRAINT "validation_cases_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_cases" ADD CONSTRAINT "validation_cases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_cases" ADD CONSTRAINT "validation_cases_seller_profile_id_seller_profiles_id_fk" FOREIGN KEY ("seller_profile_id") REFERENCES "public"."seller_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_cases" ADD CONSTRAINT "validation_cases_rating_id_engagement_ratings_id_fk" FOREIGN KEY ("rating_id") REFERENCES "public"."engagement_ratings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_cases" ADD CONSTRAINT "validation_cases_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_cases" ADD CONSTRAINT "validation_cases_seller_responded_by_users_id_fk" FOREIGN KEY ("seller_responded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_cases" ADD CONSTRAINT "validation_cases_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engagement_ratings_seller_idx" ON "engagement_ratings" USING btree ("seller_profile_id","created_at");--> statement-breakpoint
CREATE INDEX "validation_cases_status_idx" ON "validation_cases" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "validation_cases_seller_idx" ON "validation_cases" USING btree ("seller_profile_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "validation_cases_one_open_uq" ON "validation_cases" USING btree ("engagement_id") WHERE "validation_cases"."status" = 'open';