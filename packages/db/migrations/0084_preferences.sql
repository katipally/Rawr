-- Rawr had zero cross-device persistence. The rail's width, bookmarks, recent
-- navigation, a timeline filter, a collapsed panel: every one of them lived only
-- in this browser's localStorage, unscoped by account, so none of it followed a
-- person to another machine and all of it leaked between accounts on a shared
-- browser.
--
-- One table for every preference rather than one column per preference, or a
-- table per preference: the set grows as screens do, and either of those is a
-- migration for every new one this table is not. The value is JSONB precisely
-- because a preference's shape is a client-side concern; the row does not need
-- to know whether a key holds a boolean, a list, or a map.

CREATE TABLE IF NOT EXISTS public.preference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.account(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE public.preference IS
  'One person''s settings for one account: bookmarks, recent navigation, a timeline filter, a collapsed panel, the rail''s width.';
--> statement-breakpoint

-- The triple this table is keyed by, so a write is a clean upsert and a read of
-- everything one person has set is the one index scan `getPrefs` needs.
CREATE UNIQUE INDEX IF NOT EXISTS preference_scope_key_idx
  ON public.preference (account_id, user_id, key);
--> statement-breakpoint

SELECT rawr.apply_tenancy();
