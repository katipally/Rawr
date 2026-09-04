-- Sequences, sent from the member's own Gmail.
--
-- Apollo could do this, and did. What it cannot do is put the mail in the same
-- thread as the rest of the conversation, store it where every other message
-- lives, or stop the moment somebody replies, because the reply comes back
-- through a sync it knows nothing about. That is why this is in-house.

CREATE TYPE public.rawr_sequence_state AS ENUM ('draft', 'active', 'paused', 'archived');
--> statement-breakpoint
CREATE TYPE public.rawr_sequence_sender AS ENUM ('gmail', 'woodpecker');
--> statement-breakpoint
CREATE TYPE public.rawr_step_kind AS ENUM ('email', 'call', 'linkedin', 'task');
--> statement-breakpoint
CREATE TYPE public.rawr_enrollment_state AS ENUM (
  'active', 'waiting_task', 'paused', 'finished',
  'replied', 'bounced', 'unsubscribed', 'failed', 'removed'
);
--> statement-breakpoint
CREATE TYPE public.rawr_send_state AS ENUM ('sent', 'failed', 'bounced');
--> statement-breakpoint
CREATE TYPE public.rawr_sequence_event AS ENUM (
  'sent', 'open', 'click', 'reply', 'bounce', 'unsubscribe',
  'task_created', 'task_done', 'stopped'
);
--> statement-breakpoint

CREATE TABLE public.sequence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  state public.rawr_sequence_state NOT NULL DEFAULT 'draft',
  owner_id uuid REFERENCES public.user_account(id) ON DELETE SET NULL,
  sender public.rawr_sequence_sender NOT NULL DEFAULT 'gmail',
  settings jsonb NOT NULL,
  created_by uuid REFERENCES public.user_account(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sequence_workspace_name_key ON public.sequence (workspace_id, name);
--> statement-breakpoint

CREATE TABLE public.sequence_step (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL REFERENCES public.sequence(id) ON DELETE CASCADE,
  position integer NOT NULL,
  kind public.rawr_step_kind NOT NULL DEFAULT 'email',
  delay_days integer NOT NULL DEFAULT 0,
  delay_hours integer NOT NULL DEFAULT 0,
  subject text,
  body_html text,
  body_text text,
  task_title text,
  task_body text
);
CREATE INDEX sequence_step_order_idx ON public.sequence_step (workspace_id, sequence_id, position);
--> statement-breakpoint

CREATE TABLE public.sequence_enrollment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  sequence_id uuid NOT NULL REFERENCES public.sequence(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contact(id) ON DELETE CASCADE,
  mailbox_id uuid REFERENCES public.mailbox(id) ON DELETE SET NULL,
  enrolled_by uuid REFERENCES public.user_account(id) ON DELETE SET NULL,
  state public.rawr_enrollment_state NOT NULL DEFAULT 'active',
  current_step integer NOT NULL DEFAULT 0,
  next_run_at timestamptz,
  thread_id uuid REFERENCES public.message_thread(id) ON DELETE SET NULL,
  root_internet_message_id text,
  waiting_task_id uuid REFERENCES public.task(id) ON DELETE SET NULL,
  last_sent_at timestamptz,
  finished_at timestamptz,
  stop_reason text,
  unsubscribe_token text NOT NULL UNIQUE,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One live enrollment per contact per sequence. Enrolling somebody who finished
-- is allowed and deliberate: a second run next quarter is a real thing to want.
CREATE UNIQUE INDEX sequence_enrollment_live_key
  ON public.sequence_enrollment (workspace_id, sequence_id, contact_id)
  WHERE state IN ('active', 'waiting_task', 'paused');

-- The scheduler reads exactly this, once a minute. Partial, so it is the size of
-- the queue rather than of every enrollment that ever ran.
CREATE INDEX sequence_enrollment_due_idx
  ON public.sequence_enrollment (workspace_id, next_run_at)
  WHERE state = 'active';

CREATE INDEX sequence_enrollment_contact_idx ON public.sequence_enrollment (workspace_id, contact_id);
CREATE INDEX sequence_enrollment_sequence_idx ON public.sequence_enrollment (workspace_id, sequence_id, state);
--> statement-breakpoint

CREATE TABLE public.sequence_send (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL REFERENCES public.sequence_enrollment(id) ON DELETE CASCADE,
  step_id uuid REFERENCES public.sequence_step(id) ON DELETE SET NULL,
  mailbox_id uuid REFERENCES public.mailbox(id) ON DELETE SET NULL,
  message_id uuid REFERENCES public.message(id) ON DELETE SET NULL,
  provider_message_id text,
  internet_message_id text,
  token text NOT NULL UNIQUE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  state public.rawr_send_state NOT NULL DEFAULT 'sent',
  error text,
  open_count integer NOT NULL DEFAULT 0,
  click_count integer NOT NULL DEFAULT 0,
  first_opened_at timestamptz,
  last_opened_at timestamptz
);
CREATE INDEX sequence_send_mailbox_idx ON public.sequence_send (workspace_id, mailbox_id, sent_at);
CREATE INDEX sequence_send_enrollment_idx ON public.sequence_send (workspace_id, enrollment_id);
CREATE INDEX sequence_send_internet_id_idx ON public.sequence_send (workspace_id, internet_message_id);
--> statement-breakpoint

CREATE TABLE public.sequence_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  send_id uuid NOT NULL REFERENCES public.sequence_send(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  url text NOT NULL,
  click_count integer NOT NULL DEFAULT 0
);
CREATE INDEX sequence_link_send_idx ON public.sequence_link (workspace_id, send_id);
--> statement-breakpoint

CREATE TABLE public.sequence_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL REFERENCES public.sequence_enrollment(id) ON DELETE CASCADE,
  send_id uuid REFERENCES public.sequence_send(id) ON DELETE SET NULL,
  kind public.rawr_sequence_event NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  detail jsonb
);
CREATE INDEX sequence_event_enrollment_idx ON public.sequence_event (workspace_id, enrollment_id, at);
--> statement-breakpoint

-- Sending is a property of the mailbox, not of the sequence: the caps are Google's
-- and they are per account. `can_send` is false until somebody reconnects with the
-- send scope, so an existing mailbox cannot start sending because a sequence asked.
ALTER TABLE public.mailbox
  ADD COLUMN can_send boolean NOT NULL DEFAULT false,
  ADD COLUMN daily_cap integer NOT NULL DEFAULT 100,
  ADD COLUMN send_window jsonb,
  ADD COLUMN min_gap_seconds integer NOT NULL DEFAULT 45;
--> statement-breakpoint

-- Where a pixel and a click land. A dedicated host keeps sequence mail from
-- carrying links on the app's own domain, which is what gets an app domain
-- classified as bulk mail.
ALTER TABLE public.workspace ADD COLUMN tracking_domain text;
--> statement-breakpoint

-- The app role has SELECT on workspace and nothing else, so setting this goes
-- through a function scoped to the workspace pinned on the transaction.
CREATE OR REPLACE FUNCTION rawr.set_tracking_domain(p_domain text)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ws uuid := rawr.current_workspace();
BEGIN
  IF v_ws IS NULL THEN
    RAISE EXCEPTION 'no workspace is set on this transaction';
  END IF;
  UPDATE public.workspace SET tracking_domain = nullif(btrim(p_domain), '') WHERE id = v_ws;
END
$$;
REVOKE ALL ON FUNCTION rawr.set_tracking_domain(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.set_tracking_domain(text) TO rawr_app;
