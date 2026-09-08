-- What an enricher can fill that HubSpot's own enrichment fills: a company's
-- description, LinkedIn page, state, postal code, founding year, funding and
-- phone; a person's city, country, seniority and department. Columns, not
-- custom jsonb, because every one of them is a filter a segment wants.

ALTER TABLE public.company
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS linkedin_url text,
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS founded_year integer,
  ADD COLUMN IF NOT EXISTS funding_raised numeric(18, 2);
--> statement-breakpoint

ALTER TABLE public.contact
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS seniority text,
  ADD COLUMN IF NOT EXISTS department text;
--> statement-breakpoint

-- Every workspace that already exists gets the fields in its registry, in the
-- shape the seed writes them. A workspace seeded after this reads them from
-- CORE_OBJECTS instead.
INSERT INTO public.field_def (workspace_id, object_id, key, label, type, storage, column_name, is_custom, position)
SELECT o.workspace_id, o.id, f.key, f.label, f.type::public.rawr_field_type, 'column', f.key, false, f.position
  FROM public.object_def o
  CROSS JOIN (VALUES
    ('description', 'Description', 'long_text', 13),
    ('linkedin_url', 'LinkedIn company page', 'linkedin', 14),
    ('state', 'State/Region', 'text', 15),
    ('postal_code', 'Postal code', 'text', 16),
    ('founded_year', 'Year founded', 'number', 17),
    ('funding_raised', 'Total money raised', 'currency', 18)
  ) AS f(key, label, type, position)
 WHERE o.key = 'company'
   AND NOT EXISTS (SELECT 1 FROM public.field_def d WHERE d.object_id = o.id AND d.key = f.key);
--> statement-breakpoint

INSERT INTO public.field_def (workspace_id, object_id, key, label, type, storage, column_name, is_custom, position)
SELECT o.workspace_id, o.id, f.key, f.label, f.type::public.rawr_field_type, 'column', f.key, false, f.position
  FROM public.object_def o
  CROSS JOIN (VALUES
    ('city', 'City', 'text', 19),
    ('country', 'Country/Region', 'text', 20),
    ('seniority', 'Seniority', 'text', 21),
    ('department', 'Department', 'text', 22)
  ) AS f(key, label, type, position)
 WHERE o.key = 'contact'
   AND NOT EXISTS (SELECT 1 FROM public.field_def d WHERE d.object_id = o.id AND d.key = f.key);
--> statement-breakpoint

-- A record that has just gained a match key waits here until the worker asks the
-- app to enrich it. One row per record: a second request while the first waits
-- is the same request. The dispatcher deletes what it claims, so the table holds
-- only what has not run yet.
CREATE TABLE IF NOT EXISTS public.enrichment_request (
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  entity text NOT NULL,
  entity_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity, entity_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS enrichment_request_due_idx ON public.enrichment_request (requested_at);
