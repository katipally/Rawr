-- Whether a person may be measured, asked per contact and defaulted per account.
--
-- An open pixel and a click redirect are not covered by the agreement to receive
-- mail. ePrivacy Article 5(3) governs storing or reading anything on somebody's
-- device, and a one-by-one GIF fetched by their mail client is exactly that, so
-- it needs its own basis rather than riding on a subscription. That is why this
-- is a separate column from `subscription_state`: a contact can be happily
-- subscribed and still untracked, and unsubscribing must not be the only way to
-- stop being counted.
--
-- The account flag decides what silence means. Off, a contact nobody has asked
-- is tracked, which is the US position. On, only a positive 'Allowed' is, which
-- is what a French or Italian recipient is owed. 'Never' wins over both.
--
-- The type holds only the two answers a person can give; nobody having asked is
-- null, the same as any other property left blank. The values read the way they
-- are shown, because this is a CRM property somebody picks from a list on the
-- record, like contact.marketing_status, and the registry renders a select's
-- stored value as its own label.

DO $$ BEGIN
  CREATE TYPE public.rawr_tracking_consent AS ENUM ('Allowed', 'Never');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE public.contact
  ADD COLUMN IF NOT EXISTS tracking_consent public.rawr_tracking_consent;

--> statement-breakpoint
COMMENT ON COLUMN public.contact.tracking_consent IS
  'Whether mail to this person may carry a pixel or rewritten links. Null is nobody having asked, and defers to account.tracking_requires_consent.';

--> statement-breakpoint
ALTER TABLE public.account
  ADD COLUMN IF NOT EXISTS tracking_requires_consent boolean NOT NULL DEFAULT false;

--> statement-breakpoint
COMMENT ON COLUMN public.account.tracking_requires_consent IS
  'On, a contact nobody has asked is not tracked. Off, it is. Set on for ePrivacy jurisdictions.';

-- A one-off mail sent by hand belongs to a contact, not to an enrollment. Every
-- sequence rollup joins sequence_send through enrollment_id with an inner join,
-- so a null here keeps those rows out of sequence reporting without any query
-- needing a new filter.
--> statement-breakpoint
ALTER TABLE public.sequence_send
  ALTER COLUMN enrollment_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contact(id) ON DELETE SET NULL;

--> statement-breakpoint
COMMENT ON COLUMN public.sequence_send.enrollment_id IS
  'Null for a one-off send. Sequence rollups inner join here, so those rows self-exclude.';

-- Backfill, so a contact filter reads the same for mail sent before this ran.
--> statement-breakpoint
UPDATE public.sequence_send d
   SET contact_id = e.contact_id
  FROM public.sequence_enrollment e
 WHERE e.id = d.enrollment_id
   AND d.contact_id IS NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sequence_send_contact_idx
  ON public.sequence_send (account_id, contact_id, sent_at DESC);

--> statement-breakpoint
ALTER TABLE public.sequence_event
  ALTER COLUMN enrollment_id DROP NOT NULL;

--> statement-breakpoint
COMMENT ON COLUMN public.sequence_event.enrollment_id IS
  'Null when the send it describes was a one-off rather than a sequence step.';

-- Every account that already exists gets the property in its registry, in the
-- shape the seed writes it. An account seeded after this reads it from
-- CORE_OBJECTS instead. Without a field_def row the column exists and no screen,
-- filter or export can see it.
--> statement-breakpoint
INSERT INTO public.field_def
  (account_id, object_id, key, label, type, storage, column_name, is_custom, options, track_changes, position)
SELECT o.account_id, o.id, 'tracking_consent', 'Email tracking', 'select'::public.rawr_field_type,
       'column', 'tracking_consent', false,
       '["Allowed", "Never"]'::jsonb, true, 23
  FROM public.object_def o
 WHERE o.key = 'contact'
   AND NOT EXISTS (
     SELECT 1 FROM public.field_def d WHERE d.object_id = o.id AND d.key = 'tracking_consent'
   );
