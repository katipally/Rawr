-- Bodies were never stored. `message.body_ref` held `gmail:<id>`, which is not a
-- reference to anything we own: reading a body called the owner's mailbox live.
-- The moment somebody leaves and their grant is revoked, every thread they
-- brought in becomes a list of snippets, and continuity was the whole point.
--
-- Bodies live here now, hydrated by a job after the message row is stored, so a
-- slow or rate-limited fetch never costs the message itself.

CREATE TYPE public.rawr_body_state AS ENUM ('pending', 'stored', 'too_large', 'failed');
--> statement-breakpoint
CREATE TYPE public.rawr_mailbox_visibility AS ENUM ('team', 'private');
--> statement-breakpoint

ALTER TABLE public.mailbox
  ADD COLUMN visibility public.rawr_mailbox_visibility NOT NULL DEFAULT 'team';
--> statement-breakpoint

ALTER TABLE public.message
  ADD COLUMN internet_message_id text,
  ADD COLUMN in_reply_to text,
  ADD COLUMN "references" text[] NOT NULL DEFAULT '{}',
  ADD COLUMN body_state public.rawr_body_state NOT NULL DEFAULT 'pending',
  ADD COLUMN body_error text;
--> statement-breakpoint

-- Every message already stored is unhydrated by definition, and the queue is what
-- the job walks. Dropping body_ref with it: it only ever held the provider id,
-- which the row already carries in provider_message_id.
ALTER TABLE public.message DROP COLUMN body_ref;
--> statement-breakpoint

CREATE INDEX message_internet_id_idx ON public.message (workspace_id, internet_message_id);
-- The hydrate queue. Partial, so it stays the size of the backlog rather than the
-- size of the mailbox.
CREATE INDEX message_pending_body_idx ON public.message (workspace_id, id) WHERE body_state = 'pending';
--> statement-breakpoint

CREATE TABLE public.message_body (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  message_id uuid NOT NULL UNIQUE REFERENCES public.message(id) ON DELETE CASCADE,
  text_body text NOT NULL,
  html_body text,
  text_bytes integer NOT NULL DEFAULT 0,
  html_bytes integer NOT NULL DEFAULT 0,
  truncated boolean NOT NULL DEFAULT false,
  stored_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE public.message_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES public.message(id) ON DELETE CASCADE,
  filename text NOT NULL,
  mime_type text,
  size_bytes integer NOT NULL DEFAULT 0,
  provider_attachment_id text,
  inline boolean NOT NULL DEFAULT false
);
CREATE INDEX message_attachment_message_idx ON public.message_attachment (workspace_id, message_id);
--> statement-breakpoint

CREATE TABLE public.message_thread_read (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES public.message_thread(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX message_thread_read_key ON public.message_thread_read (workspace_id, thread_id, user_id);
