-- What the bell has to say, kept rather than recomputed.
--
-- The old version counted five things on every poll, on every page, for every
-- person. That is cheap enough, but it can only ever say how many: it cannot say
-- what happened, when, whether you have already seen it, or that you dealt with
-- it last week. Unread, All and Trash all need a row.
--
-- One row per person, because "read" is a fact about a person and a shared row
-- cannot carry two answers.

CREATE TYPE public.rawr_notification_kind AS ENUM (
  'task_overdue',
  'form_submission',
  'form_quarantined',
  'deal_stage_change',
  'dead_letter',
  'integration_error',
  'mailbox_revoked'
);
--> statement-breakpoint

CREATE TABLE public.notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
  kind public.rawr_notification_kind NOT NULL,
  -- What a repeated event compares against, so a nightly overdue sweep does not
  -- say the same thing every morning until the task is done. Composed by the
  -- writer, never random: same event, same key.
  dedupe_key text NOT NULL,
  title text NOT NULL,
  body text,
  -- An object key and an id. The path is built at render time from these rather
  -- than stored, so a route that changes does not leave a table of dead links.
  entity text,
  entity_id uuid,
  -- Who caused it, so the drawer never tells you that you moved your own deal.
  actor_id uuid REFERENCES public.user_account(id) ON DELETE SET NULL,
  -- How many times this same thing happened. A provider failing forty times is
  -- one line saying forty, not forty lines.
  count integer NOT NULL DEFAULT 1,
  read_at timestamptz,
  trashed_at timestamptz,
  at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- The arbiter for every insert, and the whole of the deduplication.
CREATE UNIQUE INDEX notification_dedupe_key
  ON public.notification (workspace_id, user_id, dedupe_key);
--> statement-breakpoint

-- The Unread tab and the badge, which is the query that runs on every page. The
-- index's own WHERE implies the tab's predicate, so the read is a backward index
-- scan with no sort node and no heap filter.
CREATE INDEX notification_unread_idx
  ON public.notification (workspace_id, user_id, at DESC)
  WHERE read_at IS NULL AND trashed_at IS NULL;
--> statement-breakpoint

CREATE INDEX notification_all_idx
  ON public.notification (workspace_id, user_id, at DESC)
  WHERE trashed_at IS NULL;
--> statement-breakpoint

-- Ordered by when it was thrown away rather than when it arrived, which is both
-- how a trash reads and the range the retention sweep deletes.
CREATE INDEX notification_trash_idx
  ON public.notification (workspace_id, user_id, trashed_at DESC)
  WHERE trashed_at IS NOT NULL;
--> statement-breakpoint

-- Carries workspace_id, so this picks the table up and gives it the same forced
-- tenant policy and grants as every other tenant table.
SELECT rawr.apply_tenancy();
