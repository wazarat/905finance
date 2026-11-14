CREATE TYPE "public"."qatom_connection_status" AS ENUM('connected', 'needs_reconnect');--> statement-breakpoint
CREATE TABLE "qatom_connections" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"connected_by" uuid NOT NULL,
	"client_id" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"email" text,
	"primary_twin" text,
	"agent_twin" text,
	"scope" text DEFAULT '' NOT NULL,
	"access_token_sealed" text NOT NULL,
	"access_token_expires_at" timestamp with time zone NOT NULL,
	"refresh_token_sealed" text,
	"status" "qatom_connection_status" DEFAULT 'connected' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qatom_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" text NOT NULL,
	"seller_profile_id" uuid NOT NULL,
	"engagement_id" uuid NOT NULL,
	"action" text NOT NULL,
	"nonce" text NOT NULL,
	"confirmed_with_qatom" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qatom_dispatches_transaction_id_unique" UNIQUE("transaction_id"),
	CONSTRAINT "qatom_dispatches_nonce_uq" UNIQUE("engagement_id","nonce")
);
--> statement-breakpoint
CREATE TABLE "qatom_oauth_clients" (
	"redirect_uri" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "channel" text DEFAULT 'in_app' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD COLUMN "channel_ref" text;--> statement-breakpoint
ALTER TABLE "qatom_connections" ADD CONSTRAINT "qatom_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qatom_connections" ADD CONSTRAINT "qatom_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qatom_dispatches" ADD CONSTRAINT "qatom_dispatches_seller_profile_id_seller_profiles_id_fk" FOREIGN KEY ("seller_profile_id") REFERENCES "public"."seller_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qatom_dispatches" ADD CONSTRAINT "qatom_dispatches_engagement_id_engagements_id_fk" FOREIGN KEY ("engagement_id") REFERENCES "public"."engagements"("id") ON DELETE cascade ON UPDATE no action;