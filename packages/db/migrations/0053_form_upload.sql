-- A file a stranger attached to a form, before there is a submission to hang it on.
--
-- The bytes go straight to object storage over a signed PUT, so a forty megabyte
-- CV never occupies a request worker. This row is what makes the upload
-- accountable: which form accepted it, how big it was, and whether a submission
-- ever claimed it.
--
-- Two properties matter. The id returned to the browser is the only thing the
-- form posts back, so a visitor never names a storage key and cannot reach one
-- another tenant wrote. And an unclaimed row is a dangling upload: somebody
-- attached a file and closed the tab. Those are swept, which is what the partial
-- index exists for.

CREATE TABLE public.form_upload (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES public.form(id) ON DELETE CASCADE,
  -- The path inside the bucket, carrying the workspace, so one tenant's prefix is
  -- never another's even if a bucket is ever shared or misconfigured.
  storage_key text NOT NULL,
  filename text NOT NULL,
  bytes bigint NOT NULL,
  mime text NOT NULL,
  -- Set when a submission carries this id. NULL means nothing ever did.
  submission_id uuid REFERENCES public.form_submission(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- An upload retried writes the same key, and without this the submission would
-- show the same file twice.
CREATE UNIQUE INDEX form_upload_storage_key
  ON public.form_upload (workspace_id, storage_key);
--> statement-breakpoint

-- The sweep's only query: unclaimed, oldest first. Partial, because a claimed
-- row is never swept and carrying it here would be dead weight.
CREATE INDEX form_upload_unclaimed_idx
  ON public.form_upload (workspace_id, at)
  WHERE submission_id IS NULL;
--> statement-breakpoint

CREATE INDEX form_upload_submission_idx
  ON public.form_upload (workspace_id, submission_id);
--> statement-breakpoint

SELECT rawr.apply_tenancy();
