-- A team can now route work. A form or a booking page hands each new lead or booking to
-- the next member of a team's rotation, instead of to a list of people picked on the page.
--
-- The rotation reads the turn each member last took. last_assigned_at is set when a member
-- is picked, from clock_timestamp() so two picks in a row always order the way they
-- happened. It stays null until somebody is first picked, so a member who joins a team
-- takes the next turn. Rows stored before this release keep null and are the same as
-- a member who has never been picked.
--
-- A form keeps its team inside its settings document, next to the other owner rules.
-- A booking page has no settings document, so its team is a column. The column has no
-- foreign key on purpose: deleting a team leaves its id behind, so the page can say the
-- team was deleted instead of silently losing the choice. Every read treats an id with
-- no team as no team, and the page has no hosts until somebody picks again.

ALTER TABLE public.team_member ADD COLUMN IF NOT EXISTS last_assigned_at timestamptz;

ALTER TABLE public.booking_page ADD COLUMN IF NOT EXISTS team_id uuid;

CREATE INDEX IF NOT EXISTS booking_page_team_id_idx ON public.booking_page (team_id);

-- The public page names the people who take a booking. On a team page those are the
-- team's seated members, the same people the offer draws from.
CREATE OR REPLACE FUNCTION rawr.public_booking_page(p_account_slug text, p_slug text)
 RETURNS TABLE(account_id uuid, account_slug text, account_name text, booking_page_id uuid, slug text, name text, kind rawr_booking_kind, duration_minutes integer, buffer_before_minutes integer, buffer_after_minutes integer, min_notice_minutes integer, max_horizon_days integer, granularity_minutes integer, location rawr_booking_location, location_detail text, questions jsonb, is_active boolean, redirect_url text, confirmation_copy text, host_names text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT p.account_id, w.slug, w.name, p.id, p.slug, p.name, p.kind,
           p.duration_minutes, p.buffer_before_minutes, p.buffer_after_minutes,
           p.min_notice_minutes, p.max_horizon_days, p.granularity_minutes,
           p.location, p.location_detail, p.questions, p.is_active,
           p.redirect_url, p.confirmation_copy,
           coalesce(
             (SELECT array_agg(u.name ORDER BY u.name)
                FROM (
                  SELECT h.user_id
                    FROM public.booking_host h
                   WHERE h.booking_page_id = p.id AND h.is_active AND p.team_id IS NULL
                  UNION ALL
                  SELECT tm.user_id
                    FROM public.team_member tm
                    JOIN public.membership m ON m.user_id = tm.user_id AND m.account_id = tm.account_id
                   WHERE tm.team_id = p.team_id AND m.state <> 'deactivated'
                ) r
                JOIN public.user_account u ON u.id = r.user_id),
             '{}'::text[]
           )
      FROM public.booking_page p
      JOIN public.account w ON w.id = p.account_id
     WHERE w.slug = p_account_slug AND p.slug = p_slug
$function$;
