-- What a form did, and where a marketer keeps it.
--
-- Three things arrive together because they are one screen. Folders, so 48 forms
-- are navigable. A daily counter, so the Performance tab answers "how did this
-- form do last month" without scanning every page view in the account. And the
-- property rules the public form has to honour, which until now only the record
-- panel did.
--
-- form_view is a counter, not a log. One row per form per day per page path,
-- upserted by the beacon with ON CONFLICT DO UPDATE, so a form on a page seen
-- ten thousand times is ten thousand increments of one row rather than ten
-- thousand rows. The three numbers are the three steps of the funnel that only
-- the browser can see:
--
--   views        the page carrying the form was loaded, counted server side by
--                the hosted /form page, where no page_view row exists because
--                the collector never runs there. Embedded forms take this step
--                from page_view on the paths below, which is the honest source
--                for a page Rawr does not serve.
--   renders      the form painted. A page that loads and a form that appears are
--                not the same event: a container the marketer moved, a script
--                blocked, a schema that 404s all separate them.
--   interactions somebody touched the form. Once per page load, on the first
--                event only: the step measures intent, not keystrokes.
--
-- Not consent gated, unlike the page views next to it. A row here names no
-- visitor, carries no id and cannot be joined to a person; it is the count of a
-- page, which is why it can be counted for everybody and why the conversion rate
-- it produces is not quietly missing the visitors who declined analytics.

CREATE TABLE IF NOT EXISTS public.form_folder (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE public.form_folder IS
  'Where a marketer files a form. Deleting one returns its forms to no folder; it never deletes a form.';
--> statement-breakpoint

-- Two folders called "Campaigns" in one account are a mistake every time, and
-- case is not what distinguishes them.
CREATE UNIQUE INDEX IF NOT EXISTS form_folder_name_idx
  ON public.form_folder (account_id, lower(name));
--> statement-breakpoint

ALTER TABLE public.form
  ADD COLUMN IF NOT EXISTS folder_id uuid REFERENCES public.form_folder(id) ON DELETE SET NULL;
--> statement-breakpoint

-- The list groups by folder and the sidebar counts each one. Both read this.
CREATE INDEX IF NOT EXISTS form_folder_member_idx
  ON public.form (account_id, folder_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.form_view (
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  form_id uuid NOT NULL REFERENCES public.form(id) ON DELETE CASCADE,
  day date NOT NULL,
  -- The path only, never the query string: a form on one page with a hundred
  -- campaign parameters is one row, and a utm value is not a page.
  page_path text NOT NULL,
  views integer NOT NULL DEFAULT 0,
  renders integer NOT NULL DEFAULT 0,
  interactions integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, form_id, day, page_path)
);
--> statement-breakpoint

COMMENT ON TABLE public.form_view IS
  'Daily counter per form per page path. Upserted by the embed beacon and the hosted page; names no visitor, so it is not consent gated.';
--> statement-breakpoint

-- The Performance tab reads one form over a window; the list reads every form
-- over one. Both are covered by the primary key going the other way round.
CREATE INDEX IF NOT EXISTS form_view_day_idx
  ON public.form_view (account_id, day, form_id);
--> statement-breakpoint

-- The conditional rule on a property applies wherever a person fills that
-- property in by hand, and a stranger on a web form is doing exactly that. The
-- public resolvers therefore have to ship the rules along with the schema: the
-- edge holds no account scope of its own, so it cannot read field_def itself.
--
-- Keyed the way a form field names its target, "contact.industry", so the edge
-- matches a rule to a field without a second lookup. Only the properties this
-- form actually maps to, which keeps the payload the size of the form rather
-- than the size of the registry.
CREATE OR REPLACE FUNCTION rawr.form_field_rules(p_account_id uuid, p_schema jsonb)
  RETURNS jsonb
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT coalesce(jsonb_object_agg(o.key || '.' || d.key, d.conditional), '{}'::jsonb)
      FROM public.field_def d
      JOIN public.object_def o ON o.id = d.object_id AND o.account_id = d.account_id
     WHERE d.account_id = p_account_id
       AND d.conditional IS NOT NULL
       AND d.deleted_at IS NULL
       AND o.key || '.' || d.key IN (
             SELECT entry ->> 'mapsTo'
               FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(p_schema) = 'array' THEN p_schema ELSE '[]'::jsonb END
                    ) AS entry
              WHERE jsonb_typeof(entry -> 'mapsTo') = 'string'
           )
  $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.form_field_rules(uuid, jsonb) FROM PUBLIC;
--> statement-breakpoint

-- The return columns change, and Postgres refuses to replace a function's
-- signature in place, so both are dropped first.
DROP FUNCTION IF EXISTS rawr.public_form(uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS rawr.public_form_by_slug(text, text);
--> statement-breakpoint

CREATE FUNCTION rawr.public_form(p_form_id uuid)
  RETURNS TABLE (
    account_id uuid,
    account_slug text,
    form_id uuid,
    name text,
    slug text,
    schema jsonb,
    settings jsonb,
    is_active boolean,
    rules jsonb
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT f.account_id, w.slug, f.id, f.name, f.slug, f.schema, f.settings, f.is_active,
           rawr.form_field_rules(f.account_id, f.schema)
      FROM public.form f
      JOIN public.account w ON w.id = f.account_id
     WHERE f.id = p_form_id
  $$;
--> statement-breakpoint

CREATE FUNCTION rawr.public_form_by_slug(p_account_slug text, p_slug text)
  RETURNS TABLE (
    account_id uuid,
    account_slug text,
    form_id uuid,
    name text,
    slug text,
    schema jsonb,
    settings jsonb,
    is_active boolean,
    rules jsonb
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT f.account_id, w.slug, f.id, f.name, f.slug, f.schema, f.settings, f.is_active,
           rawr.form_field_rules(f.account_id, f.schema)
      FROM public.form f
      JOIN public.account w ON w.id = f.account_id
     WHERE w.slug = p_account_slug AND f.slug = p_slug
  $$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.public_form(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rawr.public_form_by_slug(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rawr.public_form(uuid) TO rawr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rawr.public_form_by_slug(text, text) TO rawr_app;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
