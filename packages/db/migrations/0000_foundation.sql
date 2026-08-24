CREATE TYPE "public"."rawr_activity_type" AS ENUM('note', 'call', 'email', 'meeting', 'task', 'stage_change', 'lifecycle_change', 'subscription_change', 'segment_change', 'form_submission', 'booking', 'field_change', 'association_change');--> statement-breakpoint
CREATE TYPE "public"."rawr_actor_kind" AS ENUM('user', 'mcp', 'job', 'integration');--> statement-breakpoint
CREATE TYPE "public"."rawr_entity_type" AS ENUM('company', 'contact', 'deal');--> statement-breakpoint
CREATE TYPE "public"."rawr_field_storage" AS ENUM('column', 'jsonb');--> statement-breakpoint
CREATE TYPE "public"."rawr_field_type" AS ENUM('text', 'long_text', 'number', 'currency', 'percent', 'boolean', 'date', 'datetime', 'select', 'multi_select', 'email', 'phone', 'url', 'linkedin', 'address', 'user', 'relation', 'rating', 'json');--> statement-breakpoint
CREATE TYPE "public"."rawr_index_state" AS ENUM('pending', 'building', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."rawr_integration_state" AS ENUM('unconfigured', 'connected', 'degraded', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."rawr_role" AS ENUM('admin', 'sales', 'marketing', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."rawr_subscription_state" AS ENUM('subscribed', 'unsubscribed', 'unspecified');--> statement-breakpoint
CREATE TYPE "public"."rawr_view_kind" AS ENUM('table', 'board');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_kind" "rawr_actor_kind" NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "rawr_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"google_sub" text,
	"name" text NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_account_email_unique" UNIQUE("email"),
	CONSTRAINT "user_account_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"google_hosted_domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "field_def" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" "rawr_field_type" NOT NULL,
	"storage" "rawr_field_storage" NOT NULL,
	"column_name" text,
	"is_custom" boolean DEFAULT true NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"is_unique" boolean DEFAULT false NOT NULL,
	"options" jsonb,
	"default_value" jsonb,
	"help_text" text,
	"position" integer DEFAULT 0 NOT NULL,
	"is_hot" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "field_index" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"pg_index_name" text NOT NULL,
	"state" "rawr_index_state" DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "object_def" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name_singular" text NOT NULL,
	"name_plural" text NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"icon" text,
	"label_field_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "rawr_activity_type" NOT NULL,
	"subject" text,
	"body" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_id" uuid,
	"actor_kind" "rawr_actor_kind" NOT NULL,
	"source" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_link" (
	"workspace_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"entity_type" "rawr_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	CONSTRAINT "activity_link_workspace_id_activity_id_entity_type_entity_id_pk" PRIMARY KEY("workspace_id","activity_id","entity_type","entity_id")
);
--> statement-breakpoint
CREATE TABLE "association" (
	"workspace_id" uuid NOT NULL,
	"from_type" "rawr_entity_type" NOT NULL,
	"from_id" uuid NOT NULL,
	"to_type" "rawr_entity_type" NOT NULL,
	"to_id" uuid NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "association_workspace_id_from_type_from_id_to_type_to_id_pk" PRIMARY KEY("workspace_id","from_type","from_id","to_type","to_id")
);
--> statement-breakpoint
CREATE TABLE "company" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text,
	"domain" text,
	"industry" text,
	"city" text,
	"country" text,
	"phone" text,
	"employee_count" integer,
	"annual_revenue" numeric(18, 2),
	"owner_id" uuid,
	"lifecycle_stage_id" uuid,
	"original_source" jsonb,
	"latest_source" jsonb,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("name", '') || ' ' || coalesce("domain", '') || ' ' || coalesce("industry", '') || ' ' || coalesce("city", '') || ' ' || coalesce("country", ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text,
	"phone" text,
	"title" text,
	"linkedin_url" text,
	"company_id" uuid,
	"owner_id" uuid,
	"lifecycle_stage_id" uuid,
	"lead_status" text,
	"lead_source" text,
	"marketing_status" text,
	"original_source" jsonb,
	"latest_source" jsonb,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("first_name", '') || ' ' || coalesce("last_name", '') || ' ' || coalesce("email", '') || ' ' || coalesce("title", ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "deal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"amount" numeric(18, 2),
	"currency" text DEFAULT 'USD' NOT NULL,
	"close_date" date,
	"next_step" text,
	"next_step_date" date,
	"owner_id" uuid,
	"company_id" uuid,
	"deal_type" text,
	"original_source" jsonb,
	"latest_source" jsonb,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("name", '') || ' ' || coalesce("next_step", '') || ' ' || coalesce("deal_type", ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "lifecycle_stage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_stage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"probability" numeric(5, 2),
	"position" integer DEFAULT 0 NOT NULL,
	"is_closed_won" boolean DEFAULT false NOT NULL,
	"is_closed_lost" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_view" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "rawr_view_kind" DEFAULT 'table' NOT NULL,
	"owner_id" uuid,
	"is_shared" boolean DEFAULT false NOT NULL,
	"filters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sorts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"group_by_field_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"object_id" uuid NOT NULL,
	"query" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "segment_membership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"segment_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subscription_state" (
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"subscription_type_id" uuid NOT NULL,
	"state" "rawr_subscription_state" DEFAULT 'unspecified' NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text,
	CONSTRAINT "subscription_state_workspace_id_contact_id_subscription_type_id_pk" PRIMARY KEY("workspace_id","contact_id","subscription_type_id")
);
--> statement-breakpoint
CREATE TABLE "subscription_type" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_internal" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dead_letter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_id" uuid,
	"job_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"error" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"replayed_at" timestamp with time zone,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ref" text,
	"state" "rawr_integration_state" DEFAULT 'unconfigured' NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_user_account_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_def" ADD CONSTRAINT "field_def_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_def" ADD CONSTRAINT "field_def_object_id_object_def_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."object_def"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_index" ADD CONSTRAINT "field_index_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_index" ADD CONSTRAINT "field_index_field_id_field_def_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."field_def"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_def" ADD CONSTRAINT "object_def_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_link" ADD CONSTRAINT "activity_link_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_link" ADD CONSTRAINT "activity_link_activity_id_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "association" ADD CONSTRAINT "association_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_owner_id_user_account_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company" ADD CONSTRAINT "company_lifecycle_stage_id_lifecycle_stage_id_fk" FOREIGN KEY ("lifecycle_stage_id") REFERENCES "public"."lifecycle_stage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_owner_id_user_account_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_lifecycle_stage_id_lifecycle_stage_id_fk" FOREIGN KEY ("lifecycle_stage_id") REFERENCES "public"."lifecycle_stage"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_pipeline_id_pipeline_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipeline"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_stage_id_pipeline_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stage"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_owner_id_user_account_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal" ADD CONSTRAINT "deal_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_stage" ADD CONSTRAINT "lifecycle_stage_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline" ADD CONSTRAINT "pipeline_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stage" ADD CONSTRAINT "pipeline_stage_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stage" ADD CONSTRAINT "pipeline_stage_pipeline_id_pipeline_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipeline"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_object_id_object_def_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."object_def"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_owner_id_user_account_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_group_by_field_id_field_def_id_fk" FOREIGN KEY ("group_by_field_id") REFERENCES "public"."field_def"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment" ADD CONSTRAINT "segment_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment" ADD CONSTRAINT "segment_object_id_object_def_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."object_def"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_membership" ADD CONSTRAINT "segment_membership_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "segment_membership" ADD CONSTRAINT "segment_membership_segment_id_segment_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_state" ADD CONSTRAINT "subscription_state_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_state" ADD CONSTRAINT "subscription_state_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_state" ADD CONSTRAINT "subscription_state_subscription_type_id_subscription_type_id_fk" FOREIGN KEY ("subscription_type_id") REFERENCES "public"."subscription_type"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_type" ADD CONSTRAINT "subscription_type_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dead_letter" ADD CONSTRAINT "dead_letter_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dead_letter" ADD CONSTRAINT "dead_letter_integration_id_integration_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integration"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("workspace_id","entity","entity_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("workspace_id","actor_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "membership_workspace_user_key" ON "membership" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "field_def_key_key" ON "field_def" USING btree ("workspace_id","object_id","key");--> statement-breakpoint
CREATE INDEX "field_def_object_idx" ON "field_def" USING btree ("workspace_id","object_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "field_index_name_key" ON "field_index" USING btree ("pg_index_name");--> statement-breakpoint
CREATE UNIQUE INDEX "object_def_key_key" ON "object_def" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "activity_occurred_idx" ON "activity" USING btree ("workspace_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_link_entity_idx" ON "activity_link" USING btree ("workspace_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "association_reverse_idx" ON "association" USING btree ("workspace_id","to_type","to_id");--> statement-breakpoint
CREATE INDEX "company_search_idx" ON "company" USING gin ("search");--> statement-breakpoint
CREATE INDEX "company_custom_idx" ON "company" USING gin ("custom");--> statement-breakpoint
CREATE INDEX "company_owner_idx" ON "company" USING btree ("workspace_id","owner_id");--> statement-breakpoint
CREATE INDEX "company_domain_idx" ON "company" USING btree ("workspace_id","domain");--> statement-breakpoint
CREATE INDEX "company_created_idx" ON "company" USING btree ("workspace_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contact_search_idx" ON "contact" USING gin ("search");--> statement-breakpoint
CREATE INDEX "contact_custom_idx" ON "contact" USING gin ("custom");--> statement-breakpoint
CREATE INDEX "contact_company_idx" ON "contact" USING btree ("workspace_id","company_id");--> statement-breakpoint
CREATE INDEX "contact_owner_idx" ON "contact" USING btree ("workspace_id","owner_id");--> statement-breakpoint
CREATE INDEX "contact_created_idx" ON "contact" USING btree ("workspace_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deal_search_idx" ON "deal" USING gin ("search");--> statement-breakpoint
CREATE INDEX "deal_custom_idx" ON "deal" USING gin ("custom");--> statement-breakpoint
CREATE INDEX "deal_stage_idx" ON "deal" USING btree ("workspace_id","stage_id","close_date");--> statement-breakpoint
CREATE INDEX "deal_owner_idx" ON "deal" USING btree ("workspace_id","owner_id");--> statement-breakpoint
CREATE INDEX "deal_created_idx" ON "deal" USING btree ("workspace_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_stage_name_key" ON "lifecycle_stage" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_name_key" ON "pipeline" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "pipeline_stage_pipeline_idx" ON "pipeline_stage" USING btree ("workspace_id","pipeline_id","position");--> statement-breakpoint
CREATE INDEX "saved_view_object_idx" ON "saved_view" USING btree ("workspace_id","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "segment_name_key" ON "segment" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "segment_membership_segment_idx" ON "segment_membership" USING btree ("workspace_id","segment_id","entity_id");--> statement-breakpoint
CREATE INDEX "segment_membership_entity_idx" ON "segment_membership" USING btree ("workspace_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_type_name_key" ON "subscription_type" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "dead_letter_open_idx" ON "dead_letter" USING btree ("workspace_id","replayed_at","at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "integration_kind_key" ON "integration" USING btree ("workspace_id","kind");