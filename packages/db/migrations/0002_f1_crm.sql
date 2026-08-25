CREATE TYPE "public"."rawr_import_state" AS ENUM('mapping', 'previewing', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."rawr_task_status" AS ENUM('open', 'done');--> statement-breakpoint
ALTER TYPE "public"."rawr_activity_type" ADD VALUE 'merge';--> statement-breakpoint
ALTER TYPE "public"."rawr_activity_type" ADD VALUE 'import';--> statement-breakpoint
ALTER TYPE "public"."rawr_activity_type" ADD VALUE 'page_view';--> statement-breakpoint
ALTER TYPE "public"."rawr_activity_type" ADD VALUE 'custom_event';--> statement-breakpoint
ALTER TYPE "public"."rawr_activity_type" ADD VALUE 'marketing_email';--> statement-breakpoint
ALTER TYPE "public"."rawr_activity_type" ADD VALUE 'email_tracking';--> statement-breakpoint
ALTER TYPE "public"."rawr_activity_type" ADD VALUE 'sequence_activity';--> statement-breakpoint
ALTER TYPE "public"."rawr_activity_type" ADD VALUE 'enrichment';--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"due_date" date,
	"status" "rawr_task_status" DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"assignee_id" uuid,
	"entity_type" "rawr_entity_type",
	"entity_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object_type" "rawr_entity_type" NOT NULL,
	"filename" text NOT NULL,
	"file_signature" text NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "rawr_import_state" DEFAULT 'mapping' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"processed_rows" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"updated_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"errored_count" integer DEFAULT 0 NOT NULL,
	"rows" jsonb,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "activity_link_entity_idx";--> statement-breakpoint
DROP INDEX "saved_view_object_idx";--> statement-breakpoint
ALTER TABLE "field_def" ADD COLUMN "track_changes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_link" ADD COLUMN "type" "rawr_activity_type";--> statement-breakpoint
ALTER TABLE "activity_link" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
UPDATE "activity_link" l SET "type" = a."type", "occurred_at" = a."occurred_at" FROM "activity" a WHERE a."id" = l."activity_id";--> statement-breakpoint
ALTER TABLE "activity_link" ALTER COLUMN "type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_link" ALTER COLUMN "occurred_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deal" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "saved_view" ADD COLUMN "slug" text;--> statement-breakpoint
UPDATE "saved_view" SET "slug" = regexp_replace(lower("name"), '[^a-z0-9]+', '-', 'g') || '-' || left("id"::text, 8) WHERE "slug" IS NULL;--> statement-breakpoint
ALTER TABLE "saved_view" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_view" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_assignee_id_user_account_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run" ADD CONSTRAINT "import_run_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run" ADD CONSTRAINT "import_run_created_by_user_account_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_queue_idx" ON "task" USING btree ("workspace_id","status","due_date","id");--> statement-breakpoint
CREATE INDEX "task_assignee_idx" ON "task" USING btree ("workspace_id","assignee_id","status","due_date");--> statement-breakpoint
CREATE INDEX "task_entity_idx" ON "task" USING btree ("workspace_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "import_run_recent_idx" ON "import_run" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "import_run_signature_idx" ON "import_run" USING btree ("workspace_id","file_signature","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_link_timeline_idx" ON "activity_link" USING btree ("workspace_id","entity_type","entity_id","occurred_at" DESC NULLS LAST,"activity_id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "activity_link_type_idx" ON "activity_link" USING btree ("workspace_id","entity_type","entity_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "company_domain_key" ON "company" USING btree ("workspace_id","domain") WHERE domain is not null and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_email_key" ON "contact" USING btree ("workspace_id",lower("email")) WHERE email is not null and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_view_slug_key" ON "saved_view" USING btree ("workspace_id","object_id","slug");--> statement-breakpoint
CREATE INDEX "saved_view_object_idx" ON "saved_view" USING btree ("workspace_id","object_id","position");