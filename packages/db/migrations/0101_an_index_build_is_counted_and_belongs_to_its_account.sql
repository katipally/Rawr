-- "Index it" on a property of a custom object never finished: the job sent for it
-- was refused, the row stayed 'building', and the dispatcher took it back every
-- fifteen minutes for ever, because that clock ran from the row's creation and a
-- row older than fifteen minutes was always due.
--
-- `claimed_at` is when the dispatcher last took the row, so the fifteen minutes
-- run from that. `attempts` counts those takes, so a build that keeps dying ends
-- as 'failed' with a reason instead of being taken again without limit. Rows
-- already stuck have neither: they read as stale at once and are taken on the
-- next pass.
--
-- The name of an index was unique across every account, so a second account
-- indexing a property with the same key on the same object was refused with a
-- unique violation. It is unique within an account now. Every existing name was
-- unique globally, so it is unique per account and the new index builds cleanly.
--
-- Both columns are added with a constant default or none, and the table holds one
-- row per indexed property, so nothing here is noticeable.
ALTER TABLE public.field_index ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE public.field_index ADD COLUMN IF NOT EXISTS claimed_at timestamp with time zone;
--> statement-breakpoint

DROP INDEX IF EXISTS public.field_index_name_key;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS field_index_account_name_key
  ON public.field_index (account_id, pg_index_name);
