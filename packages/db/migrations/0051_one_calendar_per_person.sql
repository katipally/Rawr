-- One calendar connection per person, not one per provider.
--
-- The unique index was (workspace_id, user_id, provider), so somebody could hold a
-- `google` grant and a `dev` grant at once. Nothing in the product wants that: the
-- calendars screen shows one row and one state per person, and every read of a
-- grant was written as if there were only one.
--
-- What that cost:
--   readGrant did `where user_id = ... limit 1` with no ordering, so free-busy
--   could be read through the development provider while a real Google calendar
--   sat next to it. That provider reports no external commitments, so the engine
--   would have offered times the person was actually busy -- failing open, which
--   is the one outcome F2 §2 rules out.
--
--   readPageHosts and the meetings list both `left join calendar_grant on user_id`
--   with no provider predicate, so a second grant duplicated the host row: the
--   same person counted twice in an offer, capacity inflated, and a hold no longer
--   closing the slot it paid for.
--
-- Collapsing first, then the constraint. Google wins over dev wherever both exist:
-- a real calendar is the one that was meant.

DELETE FROM public.calendar_grant a
 USING public.calendar_grant b
 WHERE a.workspace_id = b.workspace_id
   AND a.user_id = b.user_id
   AND a.provider = 'dev'
   AND b.provider = 'google';
--> statement-breakpoint

DROP INDEX IF EXISTS calendar_grant_user_key;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS calendar_grant_user_key
  ON public.calendar_grant (workspace_id, user_id);
