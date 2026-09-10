-- The rows of a file being imported, one database row each.
--
-- They used to live in `import_run.rows`, a single jsonb column holding the whole
-- file. A HubSpot contact export is 88,301 rows: as one value that is tens of
-- megabytes rewritten in full on every chunk, because Postgres has no way to
-- update part of a jsonb document. Every 200 rows imported cost a read and a
-- write of all 88,301, which is quadratic in the length of the file and is why a
-- real migration never finished.
--
-- Split out, a chunk reads exactly the rows it is about to write, by position,
-- and writes nothing back. Position is the row's place in the file, counted from
-- zero, so `import_run.processed_rows` doubles as the resume cursor and as the
-- key of the next row to read.
--
-- account_id rides along rather than being reached through the run, because
-- rawr.apply_tenancy() finds a table by that column and a table it cannot find
-- has no tenant policy at all.

CREATE TABLE IF NOT EXISTS public.import_row (
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.import_run(id) ON DELETE CASCADE,
  position integer NOT NULL,
  -- The row as the file had it: header name to cell text, before any mapping.
  -- Quoted because `values` is a reserved word.
  "values" jsonb NOT NULL,
  PRIMARY KEY (run_id, position)
);
--> statement-breakpoint

COMMENT ON TABLE public.import_row IS
  'One row of an uploaded file. Deleted when the run finishes, fails or is cancelled: rows are only useful while the run can still resume.';
--> statement-breakpoint

-- Dropped, not backfilled. A run still holding rows here is one nobody resumed,
-- and re-uploading the file is the shorter path to finishing it.
ALTER TABLE public.import_run DROP COLUMN IF EXISTS rows;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
