-- B5. An import used to mean records: a file of contacts, companies or deals.
-- A HubSpot portal also exports its notes and its logged emails, and those belong
-- on the timeline of the record they were about, not in a column on it.
--
-- So a run says which of the two it is, and where the file came from, because the
-- HubSpot preset maps headers no hand-written export has.

CREATE TYPE "public"."rawr_import_kind" AS ENUM('records', 'activities');--> statement-breakpoint

ALTER TABLE "import_run" ADD COLUMN "import_kind" "public"."rawr_import_kind" NOT NULL DEFAULT 'records';--> statement-breakpoint
ALTER TABLE "import_run" ADD COLUMN "source" text;--> statement-breakpoint

-- Re-importing the same export must not double every note on the timeline. The
-- key is derived from the file's own identity for the row, so the second run
-- updates nothing and inserts nothing rather than appending a duplicate.
ALTER TABLE "activity" ADD COLUMN "import_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_import_key_idx" ON "activity" ("workspace_id", "import_key")
  WHERE "import_key" IS NOT NULL;
