-- The SEM container D17 promised, and the two columns that let a contact say
-- which campaign found them.
--
-- Attribution already answers "which channel", because a channel is derivable
-- from what arrived. Cost is not: nothing in a query string says an ad cost four
-- hundred pounds. So a campaign is a row somebody keys `utm_campaign` into and
-- types the spend against, and every visit, submission, contact and deal already
-- carrying that value joins onto it. Cost per contact and cost per deal are the
-- point of the whole table; without spend it would be a `group by` on a jsonb
-- field, which the website report already does.
--
-- `mailbox.alert_on_open` is here rather than in 0076 because 0076 adds an enum
-- value, and Postgres refuses to use a value in the transaction that added it, so
-- that file has to hold nothing else. The notification kind those alerts are
-- written under is `email_opened`, added there.

CREATE TABLE IF NOT EXISTS public.campaign (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  name text NOT NULL,
  source text,
  medium text,
  -- The join key. It is the value the ad platform appends, not a name somebody
  -- chose here, which is why it is the unique one and `name` is not.
  utm_campaign text NOT NULL,
  spend numeric(14, 2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  starts_on date,
  ends_on date,
  created_by uuid REFERENCES public.user_account(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE public.campaign IS
  'One paid or tracked campaign, keyed by its utm_campaign value. Holds the spend that no query string can carry.';
--> statement-breakpoint

-- Two rows claiming the same utm_campaign would split one campaign's spend
-- across two lines of the report, which is worse than refusing the second.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_utm_idx
  ON public.campaign (account_id, lower(utm_campaign));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS campaign_listing_idx
  ON public.campaign (account_id, lower(name));
--> statement-breakpoint

-- Resolved on capture and kept, rather than joined through the source jsonb on
-- every read: a list column and a report both want it, and neither wants to
-- parse a document per row. No foreign key declared in the drizzle schema for
-- these two, because `campaign` lives in the analytics schema file and `contact`
-- in the records one; the constraint is here, where there is no import cycle.
ALTER TABLE public.contact
  ADD COLUMN IF NOT EXISTS first_campaign_id uuid REFERENCES public.campaign(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_campaign_id uuid REFERENCES public.campaign(id) ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contact_first_campaign_idx
  ON public.contact (account_id, first_campaign_id)
  WHERE first_campaign_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS contact_last_campaign_idx
  ON public.contact (account_id, last_campaign_id)
  WHERE last_campaign_id IS NOT NULL;
--> statement-breakpoint

-- Every campaign the tracker has already seen, so the page opens with the real
-- list and the only thing left to type is the money. Spend zero until somebody
-- does: a report that invents a number is worse than one that shows a blank.
INSERT INTO public.campaign (account_id, name, source, medium, utm_campaign)
SELECT DISTINCT ON (s.account_id, lower(s.utm ->> 'campaign'))
       s.account_id,
       s.utm ->> 'campaign',
       s.utm ->> 'source',
       s.utm ->> 'medium',
       s.utm ->> 'campaign'
  FROM public.visitor_session s
 WHERE nullif(trim(s.utm ->> 'campaign'), '') IS NOT NULL
 ORDER BY s.account_id, lower(s.utm ->> 'campaign'), s.started_at
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- And the contacts that already carry one. Both touches are stored on the
-- contact as jsonb by the collector and the form path, so this is the same match
-- the capture path makes from now on, run once over what predates it.
UPDATE public.contact c
   SET first_campaign_id = k.id
  FROM public.campaign k
 WHERE k.account_id = c.account_id
   AND lower(k.utm_campaign) = lower(c.original_source #>> '{detail,utm,campaign}')
   AND c.first_campaign_id IS NULL;
--> statement-breakpoint

UPDATE public.contact c
   SET last_campaign_id = k.id
  FROM public.campaign k
 WHERE k.account_id = c.account_id
   AND lower(k.utm_campaign) = lower(coalesce(c.latest_source, c.original_source) #>> '{detail,utm,campaign}')
   AND c.last_campaign_id IS NULL;
--> statement-breakpoint

-- Opt in, per mailbox: "tell me when a mail I sent is opened". Off by default,
-- because a sequence of two hundred sends would otherwise fill one person's bell
-- with two hundred notices they never asked for.
ALTER TABLE public.mailbox
  ADD COLUMN IF NOT EXISTS alert_on_open boolean NOT NULL DEFAULT false;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
