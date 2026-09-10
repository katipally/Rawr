-- What a booking page sends, and what it is worth.
--
-- Until now a meeting was announced only by the calendar invitation Google writes
-- on the host's behalf. That reaches the attendee's calendar and nothing else, so
-- there was no confirmation in their inbox and nothing at all the morning of the
-- call. HubSpot's page has both: one confirmation, on by default, and any number
-- of pre-meeting reminders expressed as a number and a unit.
--
-- The reminders are rows rather than a jsonb list on the page because the worker
-- selects them across every tenant a hundred times a day, and a due predicate over
-- a jsonb array is a scan of every page rather than an index on an interval.

ALTER TABLE public.booking_page
  ADD COLUMN IF NOT EXISTS confirmation_enabled boolean NOT NULL DEFAULT true,
  -- Null means "use the wording Rawr ships", so improving that wording reaches
  -- every page that never customised it. An empty string is a customisation to
  -- nothing and is refused in the layer.
  ADD COLUMN IF NOT EXISTS confirmation_subject text,
  ADD COLUMN IF NOT EXISTS confirmation_body text,
  ADD COLUMN IF NOT EXISTS reminder_subject text,
  ADD COLUMN IF NOT EXISTS reminder_body text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.booking_reminder (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  booking_page_id uuid NOT NULL REFERENCES public.booking_page(id) ON DELETE CASCADE,
  amount integer NOT NULL CHECK (amount > 0 AND amount <= 365),
  -- Stored as the two halves a person chose rather than as minutes, because
  -- "1 week before" has to read back as one week and not as 10080 minutes.
  unit text NOT NULL CHECK (unit IN ('week', 'day', 'hour', 'minute')),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE public.booking_reminder IS
  'One pre-meeting reminder on a booking page, as the number and unit somebody chose. Several per page.';
--> statement-breakpoint

-- The same reminder twice on one page would send the same mail twice.
CREATE UNIQUE INDEX IF NOT EXISTS booking_reminder_page_key
  ON public.booking_reminder (account_id, booking_page_id, unit, amount);
--> statement-breakpoint

-- One row per reminder actually sent, which is the whole of the deduplication.
-- A worker restarting mid-tick, a retry, and two workers racing all land on the
-- same primary key, so the attendee is reminded once.
CREATE TABLE IF NOT EXISTS public.booking_reminder_sent (
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.booking(id) ON DELETE CASCADE,
  reminder_id uuid NOT NULL REFERENCES public.booking_reminder(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, booking_id, reminder_id)
);
--> statement-breakpoint

COMMENT ON TABLE public.booking_reminder_sent IS
  'Which reminder has already gone for which booking. The dedupe key for the five-minute sweep.';
--> statement-breakpoint

-- Views per page per day, not one row per view: a page in a signature is loaded
-- by every scanner that touches the mail, and a conversion rate only ever needs
-- the daily total.
CREATE TABLE IF NOT EXISTS public.booking_page_view (
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  booking_page_id uuid NOT NULL REFERENCES public.booking_page(id) ON DELETE CASCADE,
  -- The account's day in UTC. A conversion rate compared across pages needs one
  -- clock, and the strip reads a range rather than a single day.
  day date NOT NULL,
  views integer NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, booking_page_id, day)
);
--> statement-breakpoint

COMMENT ON TABLE public.booking_page_view IS
  'Daily view counter per booking page, written by the public page and the embed.';
--> statement-breakpoint

SELECT rawr.apply_tenancy();
