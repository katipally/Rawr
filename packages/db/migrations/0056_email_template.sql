-- A reusable email: the intro, the nudge, the "still interested?".
--
-- Sequences already store their steps, so this is not where a sequence lives. It
-- is what somebody drops into a step, or into a one-off reply, so the same
-- twelve sentences are not retyped slightly differently by four people.
--
-- The body is Markdown, the same characters the writer typed. The HTML that
-- reaches a recipient is rendered from it at send time, which is why nothing
-- here has to be sanitised on the way out and why the preview in the app and the
-- mail on the wire cannot drift apart.

CREATE TABLE public.email_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  name text NOT NULL,
  subject text NOT NULL DEFAULT '',
  body_text text NOT NULL DEFAULT '',
  -- Who wrote it, kept so a template outlives them: the row stays when the
  -- account goes, because the team still sends it.
  created_by uuid REFERENCES public.user_account(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Two templates called "Intro" is how somebody picks the wrong one. The name is
-- the handle people use, so it is the thing kept unique.
CREATE UNIQUE INDEX email_template_name_key
  ON public.email_template (workspace_id, lower(name));
--> statement-breakpoint

-- The picker's only query: this workspace's templates, newest edit first.
CREATE INDEX email_template_recent_idx
  ON public.email_template (workspace_id, updated_at DESC);
--> statement-breakpoint

SELECT rawr.apply_tenancy();
