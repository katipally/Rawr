-- A mailbox whose pass failed was set to 'error' and then never scheduled again,
-- because the dispatcher only selects 'connected' and 'backfilling'. The count is
-- what spaces its retries out.
ALTER TABLE public.mailbox ADD COLUMN IF NOT EXISTS failures integer NOT NULL DEFAULT 0;
