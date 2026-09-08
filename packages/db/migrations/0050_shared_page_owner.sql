-- A shared page has no owner, whatever kind of shared it is.
--
-- The old constraint enumerated the two kinds that existed when it was written,
-- so a collective page -- shared, and therefore ownerless -- failed it. Written
-- as an equivalence rather than a list, it stays right for the next kind too.
--
-- Its own migration rather than part of 0049, because a CHECK cannot read an enum
-- value added in the same transaction, and 0049 is where 'collective' is added.

ALTER TABLE public.booking_page DROP CONSTRAINT IF EXISTS booking_page_owner_ck;
--> statement-breakpoint

ALTER TABLE public.booking_page
  ADD CONSTRAINT booking_page_owner_ck
  CHECK ((kind = 'one_on_one') = (owner_id IS NOT NULL));
