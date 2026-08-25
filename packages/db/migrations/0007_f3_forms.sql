-- F3 | Forms, capture and consent.
--
-- Adds the three tables, then re-runs the tenancy helper so they get row level
-- security the same way every other tenant table did. The one new mechanism is
-- rawr.public_form(), which answers the question the public edge has to ask
-- before it has a workspace: "which tenant does this form id belong to".

ALTER TYPE public.rawr_actor_kind ADD VALUE IF NOT EXISTS 'public';
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE public.rawr_spam_state AS ENUM ('clean', 'quarantined', 'confirmed_spam', 'released');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.form (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS form_slug_key ON public.form (workspace_id, slug);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.form_submission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES public.form(id) ON DELETE CASCADE,
  values jsonb NOT NULL DEFAULT '{}'::jsonb,
  attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact_id uuid REFERENCES public.contact(id) ON DELETE SET NULL,
  company_id uuid REFERENCES public.company(id) ON DELETE SET NULL,
  visitor_id text,
  spam_score integer NOT NULL DEFAULT 0,
  spam_state public.rawr_spam_state NOT NULL DEFAULT 'clean',
  spam_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  ip_hash text,
  user_agent text,
  idempotency_key text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS form_submission_form_idx
  ON public.form_submission (workspace_id, form_id, at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS form_submission_state_idx
  ON public.form_submission (workspace_id, spam_state, at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS form_submission_contact_idx
  ON public.form_submission (workspace_id, contact_id);
--> statement-breakpoint
-- Partial, because only webhook-delivered submissions carry a key and a unique
-- index over a mostly-NULL column would otherwise be dead weight.
CREATE UNIQUE INDEX IF NOT EXISTS form_submission_idempotency_key
  ON public.form_submission (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint

-- The sixty-second duplicate-content check reads this, so it needs to be cheap.
CREATE INDEX IF NOT EXISTS form_submission_recent_idx
  ON public.form_submission (workspace_id, form_id, at DESC)
  WHERE spam_state <> 'confirmed_spam';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.consent_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  visitor_id text NOT NULL,
  categories jsonb NOT NULL,
  policy_version text NOT NULL,
  ip_hash text,
  user_agent text,
  at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS consent_record_visitor_idx
  ON public.consent_record (workspace_id, visitor_id, at DESC);
--> statement-breakpoint

-- The public edge has no session, so it cannot set a workspace before it knows
-- one. Resolving it from the request would let a caller name their own tenant,
-- which is exactly the leak this whole design exists to prevent.
--
-- So the edge asks this function instead. It takes a form id and returns that
-- form's workspace and its public shape: enough to render the form and validate
-- a submission, and nothing else. There is no path from here to a record.
CREATE OR REPLACE FUNCTION rawr.public_form(p_form_id uuid)
  RETURNS TABLE (
    workspace_id uuid,
    form_id uuid,
    name text,
    slug text,
    schema jsonb,
    settings jsonb,
    is_active boolean
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT f.workspace_id, f.id, f.name, f.slug, f.schema, f.settings, f.is_active
      FROM public.form f
     WHERE f.id = p_form_id
$$;
--> statement-breakpoint

-- The hosted page is addressed by slug, which is not unique on its own. It is
-- unique per workspace, so the site key names the tenant and the slug names the
-- form within it. Both come from the URL, never from a header a caller controls.
CREATE OR REPLACE FUNCTION rawr.public_form_by_slug(p_workspace_slug text, p_slug text)
  RETURNS TABLE (
    workspace_id uuid,
    form_id uuid,
    name text,
    slug text,
    schema jsonb,
    settings jsonb,
    is_active boolean
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT f.workspace_id, f.id, f.name, f.slug, f.schema, f.settings, f.is_active
      FROM public.form f
      JOIN public.workspace w ON w.id = f.workspace_id
     WHERE w.slug = p_workspace_slug AND f.slug = p_slug
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.public_form(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION rawr.public_form_by_slug(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.public_form(uuid) TO rawr_app;
GRANT EXECUTE ON FUNCTION rawr.public_form_by_slug(text, text) TO rawr_app;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
