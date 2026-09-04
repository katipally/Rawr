-- An owner in a portal export is often somebody who never got a Rawr account. The
-- row lands unassigned and the name is collected here, so a migration is
-- reconciled from a list of four names rather than from eighty-eight thousand
-- identical row errors.

ALTER TABLE "import_run" ADD COLUMN IF NOT EXISTS "unmatched_owners" jsonb NOT NULL DEFAULT '[]'::jsonb;
