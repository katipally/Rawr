-- What a task is, when to be reminded of it, and the list it is worked from.
--
-- HubSpot gives a task three things this one has never had. A type, so "call
-- Trevor" and "email Trevor" are not the same row with different words in it and
-- a rep can work all their calls in one sitting. A reminder, which is the notice
-- the person set for themselves before the due date rather than the one the
-- nightly sweep sends after it. And a queue: a named list you open and work top
-- to bottom, which is the only reason anybody opens a task tool twice.
--
-- A queue is a list, not a folder and not a filter. One task sits in at most one
-- of them, so `queue_id` is a column on the task rather than a join table, and
-- deleting a queue empties it rather than deleting the work inside it.
--
-- type and priority are text with a check rather than enums. The HubSpot set
-- grows with whatever integration is installed (Sales Navigator adds two), and a
-- check constraint widens in the same file as the code that uses the new value,
-- where an enum value must be added a whole migration ahead of its first use.

CREATE TABLE IF NOT EXISTS public.task_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_by uuid REFERENCES public.user_account(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE public.task_queue IS
  'A named list of tasks worked top to bottom. Deleting one returns its tasks to no queue; it never deletes work.';
--> statement-breakpoint

-- Two queues called "Monday calls" in one account are a mistake every time, and
-- case is not what distinguishes them.
CREATE UNIQUE INDEX IF NOT EXISTS task_queue_name_idx
  ON public.task_queue (account_id, lower(name));
--> statement-breakpoint

ALTER TABLE public.task
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'todo',
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'medium',
  ADD COLUMN IF NOT EXISTS queue_id uuid REFERENCES public.task_queue(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS remind_at timestamptz;
--> statement-breakpoint

ALTER TABLE public.task DROP CONSTRAINT IF EXISTS task_type_check;
--> statement-breakpoint

ALTER TABLE public.task
  ADD CONSTRAINT task_type_check CHECK (type IN ('todo', 'call', 'email'));
--> statement-breakpoint

ALTER TABLE public.task DROP CONSTRAINT IF EXISTS task_priority_check;
--> statement-breakpoint

ALTER TABLE public.task
  ADD CONSTRAINT task_priority_check CHECK (priority IN ('low', 'medium', 'high'));
--> statement-breakpoint

-- The queue sidebar counts open tasks per queue and then lists one queue's, both
-- off this index.
CREATE INDEX IF NOT EXISTS task_in_queue_idx
  ON public.task (account_id, queue_id, status, due_date);
--> statement-breakpoint

-- The reminder sweep asks one question of every account at once: which reminders
-- are due and not yet sent. Partial, because a reminder that has no time set is
-- the overwhelming majority of rows and none of them are ever an answer.
CREATE INDEX IF NOT EXISTS task_remind_idx
  ON public.task (remind_at)
  WHERE status = 'open' AND remind_at IS NOT NULL;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
