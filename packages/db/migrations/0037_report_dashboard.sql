-- B11. Reports somebody assembled, rather than the six Rawr ships.
--
-- A dashboard holds card keys and an order and nothing else. Every card is a
-- figure one of the six reports already computes, so nothing here can ask the
-- database something the reports cannot. The date range stays in the URL, as it
-- is on the reports, so a dashboard link carries the period it was read over.

CREATE TABLE "report_dashboard" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  -- Set null rather than cascade: a dashboard outlives whoever made it.
  "owner_id" uuid REFERENCES "user_account"("id") ON DELETE SET NULL,
  "is_shared" boolean NOT NULL DEFAULT false,
  "cards" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "report_dashboard_owner_idx" ON "report_dashboard" ("workspace_id", "owner_id");
