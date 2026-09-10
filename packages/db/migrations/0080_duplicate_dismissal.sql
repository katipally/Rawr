-- "Not the same", remembered.
--
-- The duplicate queue is a scan, not a list: it re-derives its pairs from the
-- records every time the page is opened. So a reviewer who decided two people
-- who share a phone are two people was told so by the screen and then shown the
-- same pair again on the next visit, for ever. A queue that cannot be emptied is
-- a queue nobody works through.
--
-- One row per pair per account, and the pair is stored ordered — smaller uuid in
-- left_id — so that the same two records dismissed from either side of the
-- screen, or proposed later by a different rule, are one row and not two.
--
-- Deliberately not a rule change. A dismissal hides these two records from each
-- other and teaches the finder nothing: a rule that learns from a dismissal is a
-- rule nobody can predict, and the action on the other end of this queue cannot
-- be undone.

CREATE TABLE IF NOT EXISTS public.duplicate_dismissal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  -- 'contact' or 'company'. Text rather than an enum, and no foreign key on the
  -- two ids: the object key decides which table they point at, which is the
  -- shape attachment and activity_link already use.
  entity_type text NOT NULL,
  left_id uuid NOT NULL,
  right_id uuid NOT NULL,
  dismissed_by uuid REFERENCES public.user_account(id) ON DELETE SET NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT duplicate_dismissal_ordered CHECK (left_id < right_id)
);
--> statement-breakpoint

COMMENT ON TABLE public.duplicate_dismissal IS
  'Two records somebody looked at and said are not the same. Keeps the pair out of the duplicate queue.';
--> statement-breakpoint

-- The unique index is also the one the queue reads: every dismissal for one
-- account and object type is loaded once per page, so the covering order is
-- account, type, then the pair.
CREATE UNIQUE INDEX IF NOT EXISTS duplicate_dismissal_pair_idx
  ON public.duplicate_dismissal (account_id, entity_type, left_id, right_id);
--> statement-breakpoint

SELECT rawr.apply_tenancy();
