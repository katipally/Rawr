-- B8. The view tabs above a list are an arrangement, not a preference: a pinned
-- view is one the whole workspace sees as a tab, and the rest live behind "All
-- views". Pinning is shared for the same reason position is shared, so the tab
-- bar a person describes in Slack is the tab bar the reader opens.

ALTER TABLE "saved_view" ADD COLUMN "pinned" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- The tab bar reads pinned-first then position, which is the order this index
-- already serves once pinned leads it.
DROP INDEX IF EXISTS "saved_view_object_idx";--> statement-breakpoint
CREATE INDEX "saved_view_object_idx" ON "saved_view" ("workspace_id","object_id","pinned" DESC,"position");
