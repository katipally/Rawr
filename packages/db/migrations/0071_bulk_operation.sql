-- A bulk action over more records than one request should hold open.
--
-- The bulk bar applies delete, owner, association or list membership to whatever
-- is ticked. Under a couple of hundred that is one call and the person watches it
-- finish. Above it the same work has to outlive the tab, for the reason an import
-- does: the browser gives up long before eighty thousand soft deletes do.
--
-- So the selection is written here once and the worker asks the app for one chunk
-- at a time, exactly as it does for a file. `processed` is both the progress the
-- toolbar shows and the resume cursor, so a run interrupted by a deploy continues
-- from the id after the last one it wrote rather than starting again.
--
-- The ids are a uuid[] rather than their own table: a selection comes from ticked
-- rows, so it is bounded by what a person can tick, and a chunk reads the slice it
-- is about to write without rewriting the column.

CREATE TABLE IF NOT EXISTS public.bulk_operation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  -- delete | assign | associate | add_to_list. Text rather than an enum because
  -- the bar grows an action more often than the database wants a new type.
  kind text NOT NULL,
  object_key text NOT NULL,
  ids uuid[] NOT NULL,
  -- What the action needs beyond the selection: the owner, the record to link to,
  -- the list to add to.
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'running',
  total integer NOT NULL,
  processed integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  -- A sample of what refused the change, named, so "12 of 500 failed" is
  -- something somebody can act on. Capped when it is written.
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_error text,
  created_by uuid REFERENCES public.user_account(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
--> statement-breakpoint

COMMENT ON TABLE public.bulk_operation IS
  'One bulk bar action over a selection too large to run in a request. Chunked by the worker; processed doubles as progress and as the resume cursor.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS bulk_operation_recent_idx
  ON public.bulk_operation (account_id, created_at DESC);
--> statement-breakpoint

-- The dispatcher asks once a minute which runs are still going, across every
-- account. Partial, so it stays the size of the work in flight rather than the
-- size of the history.
CREATE INDEX IF NOT EXISTS bulk_operation_running_idx
  ON public.bulk_operation (account_id) WHERE state = 'running';
--> statement-breakpoint

SELECT rawr.apply_tenancy();
