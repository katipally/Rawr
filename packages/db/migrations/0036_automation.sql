-- B11. When this happens, do that.
--
-- Everything automatic in Rawr before this was hard-wired: segments recompute on
-- the hour, sequences advance, and one deal stage change posts to one Slack
-- channel. Every other rule a team wanted needed a deploy.
--
-- Triggers are events Rawr already emits on a write, so nothing polls. That is
-- also why "no activity for thirty days" is absent: it is the one useful trigger
-- that is not an event, and it needs a scan the others do not.

CREATE TYPE "public"."rawr_automation_trigger" AS ENUM(
  'record_created', 'stage_changed', 'lifecycle_changed', 'form_submitted');--> statement-breakpoint

-- 'skipped' is the interesting state: armed, fired, and a condition was false.
-- A log of successes cannot tell a broken rule from one that simply is not
-- matching.
CREATE TYPE "public"."rawr_automation_state" AS ENUM('done', 'skipped', 'failed');--> statement-breakpoint

CREATE TABLE "automation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT false,
  "trigger" "public"."rawr_automation_trigger" NOT NULL,
  "trigger_config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "conditions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "actions" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_by" uuid REFERENCES "user_account"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "automation_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "automation_id" uuid NOT NULL REFERENCES "automation"("id") ON DELETE CASCADE,
  "entity_type" "public"."rawr_entity_type" NOT NULL,
  "entity_id" uuid NOT NULL,
  "state" "public"."rawr_automation_state" NOT NULL,
  "detail" text,
  "at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- The only query the runner makes: what is armed for this event.
CREATE INDEX "automation_trigger_idx" ON "automation" ("workspace_id", "trigger", "is_active");--> statement-breakpoint
CREATE INDEX "automation_run_recent_idx" ON "automation_run" ("workspace_id", "automation_id", "at" DESC);--> statement-breakpoint
CREATE INDEX "automation_run_entity_idx" ON "automation_run" ("workspace_id", "entity_id");
