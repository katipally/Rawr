-- F4 | Activity analytics.
--
-- Nine tables, then the tenancy helper so every one of them gets row level
-- security the same way every other tenant table did.
--
-- The one new public-edge mechanism is rawr.public_site(), which answers the
-- question the collector has to ask before it has a workspace: "which tenant owns
-- this site key". Same shape as rawr.public_form(): it takes a key, returns
-- nothing but ids, and is the only path from an anonymous request to a tenant.

DO $$ BEGIN
  CREATE TYPE public.rawr_alias_via AS ENUM ('form_submission', 'booking', 'product_signin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.site (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  name text NOT NULL,
  host text NOT NULL,
  site_key text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Unique across every tenant, not per workspace: the collector has only this
-- string to resolve a workspace from.
CREATE UNIQUE INDEX IF NOT EXISTS site_key_unique ON public.site (site_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS site_workspace_idx ON public.site (workspace_id, host);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.visitor (
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  id text NOT NULL,
  contact_id uuid REFERENCES public.contact(id) ON DELETE SET NULL,
  first_referrer text,
  first_landing_page text,
  session_count integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS visitor_contact_idx ON public.visitor (workspace_id, contact_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.visitor_alias (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  visitor_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES public.contact(id) ON DELETE CASCADE,
  via public.rawr_alias_via NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  last_error text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS visitor_alias_key
  ON public.visitor_alias (workspace_id, visitor_id, contact_id);
--> statement-breakpoint

-- The back-fill queue. Partial, and deliberately not workspace-first: the worker
-- claims across tenants in arrival order, the same way field_index dispatch does.
CREATE INDEX IF NOT EXISTS visitor_alias_pending_idx
  ON public.visitor_alias (created_at) WHERE resolved_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS visitor_alias_contact_idx
  ON public.visitor_alias (workspace_id, contact_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.visitor_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  visitor_id text NOT NULL,
  site_id uuid REFERENCES public.site(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NOT NULL DEFAULT now(),
  entry_path text,
  exit_path text,
  page_count integer NOT NULL DEFAULT 0,
  referrer text,
  utm jsonb NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS visitor_session_visitor_idx
  ON public.visitor_session (workspace_id, visitor_id, ended_at DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.page_view (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  visitor_id text NOT NULL,
  contact_id uuid REFERENCES public.contact(id) ON DELETE SET NULL,
  session_id uuid REFERENCES public.visitor_session(id) ON DELETE SET NULL,
  site_id uuid REFERENCES public.site(id) ON DELETE SET NULL,
  url text NOT NULL,
  path text NOT NULL,
  title text,
  referrer text,
  utm jsonb NOT NULL DEFAULT '{}'::jsonb,
  ua_family text,
  device text,
  country text,
  at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- The back-fill's only query, and the narrowest it can be: an identification
-- touches nothing that is already attributed.
CREATE INDEX IF NOT EXISTS page_view_backfill_idx
  ON public.page_view (workspace_id, visitor_id) WHERE contact_id IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS page_view_visitor_idx
  ON public.page_view (workspace_id, visitor_id, at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS page_view_contact_idx
  ON public.page_view (workspace_id, contact_id, at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS page_view_session_idx
  ON public.page_view (workspace_id, session_id, at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.custom_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  visitor_id text NOT NULL,
  contact_id uuid REFERENCES public.contact(id) ON DELETE SET NULL,
  session_id uuid REFERENCES public.visitor_session(id) ON DELETE SET NULL,
  site_id uuid REFERENCES public.site(id) ON DELETE SET NULL,
  name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS custom_event_backfill_idx
  ON public.custom_event (workspace_id, visitor_id) WHERE contact_id IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS custom_event_visitor_idx
  ON public.custom_event (workspace_id, visitor_id, at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS custom_event_contact_idx
  ON public.custom_event (workspace_id, contact_id, at DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.contact_activity (
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contact(id) ON DELETE CASCADE,
  site_visits integer NOT NULL DEFAULT 0,
  pages_viewed integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  PRIMARY KEY (workspace_id, contact_id)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.page_view_daily (
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contact(id) ON DELETE CASCADE,
  day date NOT NULL,
  views integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, contact_id, day)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.event_name_day (
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  day date NOT NULL,
  name text NOT NULL,
  PRIMARY KEY (workspace_id, day, name)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.collector_notice (
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.site(id) ON DELETE CASCADE,
  kind text NOT NULL,
  key text NOT NULL,
  day date NOT NULL,
  n integer NOT NULL DEFAULT 1,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, site_id, kind, key, day)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS collector_notice_recent_idx
  ON public.collector_notice (workspace_id, last_at DESC);
--> statement-breakpoint

-- The collector's workspace resolver. Returns the site as well as the workspace,
-- because every row it writes is attributed to one, and inactive sites resolve to
-- nothing so turning a site off actually stops collection.
CREATE OR REPLACE FUNCTION rawr.public_site(p_site_key text)
  RETURNS TABLE (workspace_id uuid, site_id uuid, host text)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT s.workspace_id, s.id, s.host
      FROM public.site s
     WHERE s.site_key = p_site_key AND s.is_active
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.public_site(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rawr.public_site(text) TO rawr_app;
--> statement-breakpoint

-- F3 shipped before a site table existed and resolves the consent endpoint's
-- workspace from the workspace slug. Both are live on the same embed, so this now
-- prefers a real site key and keeps the slug as the fallback. Migration path: once
-- every embed on datasaur.ai carries a site key, the second branch can go.
CREATE OR REPLACE FUNCTION rawr.workspace_for_site(p_site_key text)
  RETURNS TABLE (id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT s.workspace_id FROM public.site s
      WHERE s.site_key = p_site_key AND s.is_active
    UNION ALL
    SELECT w.id FROM public.workspace w
      WHERE w.slug = p_site_key
        AND NOT EXISTS (SELECT 1 FROM public.site s2 WHERE s2.site_key = p_site_key)
$$;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
