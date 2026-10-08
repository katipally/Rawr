-- An inbox thread can now be archived, moved to Trash and assigned to a teammate, and
-- read or unread for the person who asked. Archive and Trash are shared by everybody who
-- may see the thread; assignment is too, because a teammate owns it.
--
-- Rawr records each change at once and the worker pushes it to Gmail afterwards.
-- state_changed_at is set by every change Rawr makes, and gmail_synced_at takes the same
-- value once Gmail has been told. A thread is waiting to be pushed while the two differ.
-- A Gmail-side change is read back only when nothing is waiting, so it never overwrites
-- a change Rawr has not delivered yet.
--
-- Read state is per person, so the Gmail UNREAD flag waits on the reader's own row:
-- gmail_unread is what Gmail should say, and null means nothing is waiting.
--
-- can_modify is what Google granted: gmail.modify, which archive, trash and unread need.
-- A mailbox connected before this release has none and keeps reading and sending; its
-- owner is asked to reconnect. Rows stored before this release keep the defaults below.

ALTER TABLE public.message_thread ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.message_thread ADD COLUMN IF NOT EXISTS trashed_at timestamptz;
ALTER TABLE public.message_thread ADD COLUMN IF NOT EXISTS assigned_to uuid REFERENCES public.user_account(id) ON DELETE SET NULL;
ALTER TABLE public.message_thread ADD COLUMN IF NOT EXISTS state_changed_at timestamptz;
ALTER TABLE public.message_thread ADD COLUMN IF NOT EXISTS gmail_synced_at timestamptz;

ALTER TABLE public.message_thread_read ADD COLUMN IF NOT EXISTS gmail_unread boolean;

ALTER TABLE public.mailbox ADD COLUMN IF NOT EXISTS can_modify boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS message_thread_assigned_to_idx ON public.message_thread (account_id, assigned_to);

-- What the worker's dispatcher reads each pass, kept small while nothing is waiting.
CREATE INDEX IF NOT EXISTS message_thread_gmail_pending_idx ON public.message_thread (account_id)
  WHERE state_changed_at IS DISTINCT FROM gmail_synced_at;
CREATE INDEX IF NOT EXISTS message_thread_read_gmail_unread_idx ON public.message_thread_read (account_id)
  WHERE gmail_unread IS NOT NULL;
