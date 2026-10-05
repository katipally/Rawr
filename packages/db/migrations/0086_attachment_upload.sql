-- The upload endpoint checked that a key began with the account's id and nothing
-- else, so any member could PUT bytes to any key under that prefix: over a filed
-- attachment, or in bulk to fill the bucket. `attachments.begin` named the key but
-- recorded nothing, so there was nothing for the endpoint to check it against.
--
-- A row here is "this person may send this many bytes to this key until it
-- expires". Filing the attachment deletes it, which is what stops a filed key
-- accepting a second write.

CREATE TABLE IF NOT EXISTS public.attachment_upload (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  bytes bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE public.attachment_upload IS
  'An upload that was begun and not yet filed: the key, who may send to it, how many bytes, and when it stops being accepted.';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS attachment_upload_key_idx
  ON public.attachment_upload (account_id, storage_key);
--> statement-breakpoint

-- The sweep that runs on each begin deletes by this.
CREATE INDEX IF NOT EXISTS attachment_upload_expiry_idx
  ON public.attachment_upload (expires_at);
--> statement-breakpoint

SELECT rawr.apply_tenancy();
