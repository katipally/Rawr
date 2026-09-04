-- B7. Reporting reads sessions by channel over a date range, and neither of those
-- is answerable from what a session stored.
--
-- The channel is written on the session rather than derived at read time: the
-- rules can change, but a report over a year of traffic must not re-derive seven
-- buckets for every row on every open. The evidence it was derived from stays in
-- the referrer and utm columns beside it, so a rule change can rewrite the column
-- rather than needing traffic nobody kept.

ALTER TABLE "visitor_session" ADD COLUMN "channel" text;--> statement-breakpoint

-- The range scan every website and attribution report starts from.
CREATE INDEX "visitor_session_started_idx" ON "visitor_session" ("workspace_id", "started_at" DESC);--> statement-breakpoint
CREATE INDEX "visitor_session_channel_idx" ON "visitor_session" ("workspace_id", "channel", "started_at" DESC);--> statement-breakpoint

-- Deals and contacts are already indexed on (workspace_id, created_at desc), which
-- is what the per-week scans range over, so nothing is added for them here.

-- Sessions that predate the column keep a null channel rather than a guessed one.
-- Backfilling from referrer and utm alone would silently call a paid click direct,
-- and a report is better off saying "not attributed" than saying the wrong thing.
UPDATE "visitor_session" SET "channel" = 'Direct Traffic'
 WHERE "channel" IS NULL AND "referrer" IS NULL AND "utm" = '{}'::jsonb;
