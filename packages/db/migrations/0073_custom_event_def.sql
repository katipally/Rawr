-- What the events a site fires are called, and what they mean.
--
-- The collector already stores a `custom_event` row under whatever name arrived,
-- capped per day by `event_name_day`. That is enough to count with and not enough
-- to work with: nobody can build a funnel out of a table they cannot see, and
-- "signup_started" needs a human label and a property schema before anybody but
-- the engineer who fired it knows what it records.
--
-- So a definition is a description laid over names that already exist rather than
-- a gate in front of them. `discovered` says which side it came from: true is a
-- name the collector saw and nobody has described yet, false is one somebody
-- wrote down. An event is never refused for having no definition, because the
-- alternative is silently losing the signal that a new release started firing.

CREATE TABLE IF NOT EXISTS public.custom_event_def (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  name text NOT NULL,
  label text,
  -- {property: {type, label}}, the shape the site promises to send. Advisory:
  -- the collector strips PII and stores the rest whatever this says.
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  discovered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE public.custom_event_def IS
  'A label and a property schema for an event name. Describes what the collector already stores; never gates it.';
--> statement-breakpoint

-- One definition per name. Case is not what distinguishes two events, and the
-- collector trims but does not lower-case, so "Signup" and "signup" arriving from
-- two releases of the same site are one thing to describe.
CREATE UNIQUE INDEX IF NOT EXISTS custom_event_def_name_idx
  ON public.custom_event_def (account_id, lower(name));
--> statement-breakpoint

-- The settings tab lists described names first, then what is still undescribed.
CREATE INDEX IF NOT EXISTS custom_event_def_listing_idx
  ON public.custom_event_def (account_id, discovered, lower(name));
--> statement-breakpoint

-- Every name the collector has already seen, so the tab opens with the site's
-- real vocabulary rather than an empty list somebody has to type from memory.
-- `_overflow` is the cardinality bucket, not an event anybody fired.
INSERT INTO public.custom_event_def (account_id, name, discovered)
SELECT DISTINCT d.account_id, d.name, true
  FROM public.event_name_day d
 WHERE d.name <> '_overflow'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- The events report groups one account's events by name and day, and the funnel
-- walks the same rows in time order per visitor.
CREATE INDEX IF NOT EXISTS custom_event_name_at_idx
  ON public.custom_event (account_id, name, at DESC);
--> statement-breakpoint

SELECT rawr.apply_tenancy();
