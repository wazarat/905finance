CREATE TABLE "seller_identities" (
	"seller_profile_id" uuid PRIMARY KEY NOT NULL,
	"agent_registry" text NOT NULL,
	"agent_id" text NOT NULL,
	"owner_address" text NOT NULL,
	"agent_wallet" text NOT NULL,
	"agent_wallet_set" boolean DEFAULT false NOT NULL,
	"agent_uri" text DEFAULT '' NOT NULL,
	"registration" jsonb,
	"registration_problem" text,
	"confirmed" boolean DEFAULT false NOT NULL,
	"reputation_clients" integer DEFAULT 0 NOT NULL,
	"reputation_count" integer DEFAULT 0 NOT NULL,
	"reputation_value" text,
	"linked_by" uuid,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_identities_agent_uq" UNIQUE("agent_registry","agent_id")
);
--> statement-breakpoint
ALTER TABLE "seller_identities" ADD CONSTRAINT "seller_identities_seller_profile_id_seller_profiles_id_fk" FOREIGN KEY ("seller_profile_id") REFERENCES "public"."seller_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seller_identities" ADD CONSTRAINT "seller_identities_linked_by_users_id_fk" FOREIGN KEY ("linked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;