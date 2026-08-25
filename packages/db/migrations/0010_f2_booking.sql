-- F2 | Booking. Round robin pages, personal calendar links, availability,
-- holds, bookings and per-user calendar grants.
--
-- Two new mechanisms beyond the tables. First, the public resolvers: a visitor
-- reaching /b/:workspace/:slug has no session, and neither does someone clicking
-- a cancel link in a confirmation mail, so both questions are answered by
-- security-definer functions that return an id and nothing else. Second, a
-- partial unique index on (host, slot) for confirmed bookings, which makes a
-- double booking unreachable even if every application check above it is wrong.

DO $$ BEGIN
  CREATE TYPE public.rawr_booking_kind AS ENUM ('one_on_one', 'round_robin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE public.rawr_booking_location AS ENUM ('zoom', 'google_meet', 'phone', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE public.rawr_booking_state AS ENUM ('confirmed', 'cancelled', 'rescheduled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE public.rawr_calendar_provider AS ENUM ('google', 'dev');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.booking_page (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  kind public.rawr_booking_kind NOT NULL DEFAULT 'round_robin',
  owner_id uuid REFERENCES public.user_account(id) ON DELETE CASCADE,
  duration_minutes integer NOT NULL DEFAULT 30,
  buffer_before_minutes integer NOT NULL DEFAULT 0,
  buffer_after_minutes integer NOT NULL DEFAULT 0,
  min_notice_minutes integer NOT NULL DEFAULT 240,
  max_horizon_days integer NOT NULL DEFAULT 60,
  granularity_minutes integer NOT NULL DEFAULT 30,
  location public.rawr_booking_location NOT NULL DEFAULT 'zoom',
  location_detail text,
  title_tpl text NOT NULL,
  description_tpl text NOT NULL,
  company_fallback text NOT NULL DEFAULT 'a new team',
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  redirect_url text,
  confirmation_copy text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Ranges a person cannot recover from if they are wrong: a zero duration page
  -- offers slots that end before they start, and a zero granularity loops.
  CONSTRAINT booking_page_duration_ck CHECK (duration_minutes BETWEEN 5 AND 1440),
  CONSTRAINT booking_page_granularity_ck CHECK (granularity_minutes BETWEEN 5 AND 1440),
  CONSTRAINT booking_page_horizon_ck CHECK (max_horizon_days BETWEEN 1 AND 365),
  CONSTRAINT booking_page_buffer_ck CHECK (
    buffer_before_minutes BETWEEN 0 AND 480 AND buffer_after_minutes BETWEEN 0 AND 480
  ),
  CONSTRAINT booking_page_notice_ck CHECK (min_notice_minutes BETWEEN 0 AND 43200),
  -- A one-on-one page is somebody's own link, so it has an owner. A round robin
  -- belongs to the workspace and must not pretend to have one.
  CONSTRAINT booking_page_owner_ck CHECK (
    (kind = 'one_on_one' AND owner_id IS NOT NULL) OR (kind = 'round_robin' AND owner_id IS NULL)
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS booking_page_slug_key ON public.booking_page (workspace_id, slug);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS booking_page_owner_idx ON public.booking_page (workspace_id, owner_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.booking_host (
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  booking_page_id uuid NOT NULL REFERENCES public.booking_page(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
  weight integer NOT NULL DEFAULT 1,
  last_assigned_at timestamptz,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, booking_page_id, user_id),
  CONSTRAINT booking_host_weight_ck CHECK (weight BETWEEN 1 AND 100)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_host_user_idx ON public.booking_host (workspace_id, user_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'America/Los_Angeles',
  weekly jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS availability_user_key ON public.availability (workspace_id, user_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.availability_override (
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
  day date NOT NULL,
  is_unavailable boolean NOT NULL DEFAULT true,
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, day)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.booking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  booking_page_id uuid NOT NULL REFERENCES public.booking_page(id) ON DELETE RESTRICT,
  host_user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE RESTRICT,
  contact_id uuid REFERENCES public.contact(id) ON DELETE SET NULL,
  company_id uuid REFERENCES public.company(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  attendee_timezone text NOT NULL,
  attendee_name text NOT NULL,
  attendee_email text NOT NULL,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  conference_url text,
  conference_ref text,
  calendar_event_id text,
  calendar_id text,
  state public.rawr_booking_state NOT NULL DEFAULT 'confirmed',
  reschedule_of uuid REFERENCES public.booking(id) ON DELETE SET NULL,
  cancel_token text NOT NULL,
  reschedule_token text NOT NULL,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_window_ck CHECK (ends_at > starts_at)
);
--> statement-breakpoint

-- The invariant. One person, one confirmed meeting per start instant. A round
-- robin offering the same slot to three hosts is still legal, which is why this
-- is keyed on the host and not on the page.
CREATE UNIQUE INDEX IF NOT EXISTS booking_host_slot_key
  ON public.booking (workspace_id, host_user_id, starts_at)
  WHERE state = 'confirmed';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS booking_host_window_idx
  ON public.booking (workspace_id, host_user_id, starts_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS booking_page_idx
  ON public.booking (workspace_id, booking_page_id, starts_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS booking_contact_idx ON public.booking (workspace_id, contact_id);
--> statement-breakpoint
-- Global, not per workspace: the token is the only thing a cancel link carries,
-- so it has to be unique across every tenant to be resolvable without a scope.
CREATE UNIQUE INDEX IF NOT EXISTS booking_cancel_token_key ON public.booking (cancel_token);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS booking_reschedule_token_key ON public.booking (reschedule_token);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.booking_hold (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  booking_page_id uuid NOT NULL REFERENCES public.booking_page(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS booking_hold_token_key ON public.booking_hold (token);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS booking_hold_slot_idx
  ON public.booking_hold (workspace_id, booking_page_id, starts_at, expires_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.calendar_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
  provider public.rawr_calendar_provider NOT NULL DEFAULT 'google',
  calendar_id text NOT NULL DEFAULT 'primary',
  state public.rawr_integration_state NOT NULL DEFAULT 'unconfigured',
  access_token_enc text,
  refresh_token_enc text,
  access_token_expires_at timestamptz,
  scope text,
  last_ok_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS calendar_grant_user_key
  ON public.calendar_grant (workspace_id, user_id, provider);
--> statement-breakpoint

-- A visitor on /b/:workspace/:slug has no session. Same pattern as the form
-- resolvers: the page's public shape and its workspace id, nothing that could
-- reach a record.
CREATE OR REPLACE FUNCTION rawr.public_booking_page(p_workspace_slug text, p_slug text)
  RETURNS TABLE (
    workspace_id uuid,
    workspace_slug text,
    workspace_name text,
    booking_page_id uuid,
    slug text,
    name text,
    kind public.rawr_booking_kind,
    duration_minutes integer,
    buffer_before_minutes integer,
    buffer_after_minutes integer,
    min_notice_minutes integer,
    max_horizon_days integer,
    granularity_minutes integer,
    location public.rawr_booking_location,
    location_detail text,
    questions jsonb,
    is_active boolean,
    redirect_url text,
    confirmation_copy text
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT p.workspace_id, w.slug, w.name, p.id, p.slug, p.name, p.kind,
           p.duration_minutes, p.buffer_before_minutes, p.buffer_after_minutes,
           p.min_notice_minutes, p.max_horizon_days, p.granularity_minutes,
           p.location, p.location_detail, p.questions, p.is_active,
           p.redirect_url, p.confirmation_copy
      FROM public.booking_page p
      JOIN public.workspace w ON w.id = p.workspace_id
     WHERE w.slug = p_workspace_slug AND p.slug = p_slug
$$;
--> statement-breakpoint

-- Someone clicking a reschedule link in their confirmation mail has no session
-- either. The token is the credential; this returns which tenant to scope to and
-- which booking it addresses, and refuses to answer for the wrong purpose.
CREATE OR REPLACE FUNCTION rawr.booking_for_token(p_purpose text, p_token text)
  RETURNS TABLE (workspace_id uuid, booking_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT b.workspace_id, b.id
      FROM public.booking b
     WHERE (p_purpose = 'cancel' AND b.cancel_token = p_token)
        OR (p_purpose = 'reschedule' AND b.reschedule_token = p_token)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rawr.booking_hold_workspace(p_token text)
  RETURNS TABLE (workspace_id uuid, booking_page_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT h.workspace_id, h.booking_page_id FROM public.booking_hold h WHERE h.token = p_token
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.public_booking_page(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rawr.booking_for_token(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION rawr.booking_hold_workspace(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.public_booking_page(text, text) TO rawr_app;
GRANT EXECUTE ON FUNCTION rawr.booking_for_token(text, text) TO rawr_app;
GRANT EXECUTE ON FUNCTION rawr.booking_hold_workspace(text) TO rawr_app;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
