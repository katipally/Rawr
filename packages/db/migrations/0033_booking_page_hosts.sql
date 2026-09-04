-- A booking page never said who the meeting is with. Every calendar link a person
-- has used says that, and a visitor deciding whether to give up half an hour is
-- deciding about a person, not about a slug.
--
-- Names only, never addresses: the page is public, and a public page that prints
-- staff email addresses is a scraper's list.

DROP FUNCTION IF EXISTS rawr.public_booking_page(text, text);--> statement-breakpoint

CREATE FUNCTION rawr.public_booking_page(p_workspace_slug text, p_slug text)
  RETURNS TABLE (
    workspace_id uuid,
    workspace_slug text,
    workspace_name text,
    booking_page_id uuid,
    slug text,
    name text,
    kind public.rawr_booking_kind,
    duration_minutes integer,
    buffer_before_minutes integer,
    buffer_after_minutes integer,
    min_notice_minutes integer,
    max_horizon_days integer,
    granularity_minutes integer,
    location public.rawr_booking_location,
    location_detail text,
    questions jsonb,
    is_active boolean,
    redirect_url text,
    confirmation_copy text,
    host_names text[]
  )
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
    SELECT p.workspace_id, w.slug, w.name, p.id, p.slug, p.name, p.kind,
           p.duration_minutes, p.buffer_before_minutes, p.buffer_after_minutes,
           p.min_notice_minutes, p.max_horizon_days, p.granularity_minutes,
           p.location, p.location_detail, p.questions, p.is_active,
           p.redirect_url, p.confirmation_copy,
           coalesce(
             (SELECT array_agg(u.name ORDER BY u.name)
                FROM public.booking_host h
                JOIN public.user_account u ON u.id = h.user_id
               WHERE h.booking_page_id = p.id AND h.is_active),
             '{}'::text[]
           )
      FROM public.booking_page p
      JOIN public.workspace w ON w.id = p.workspace_id
     WHERE w.slug = p_workspace_slug AND p.slug = p_slug
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION rawr.public_booking_page(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rawr.public_booking_page(text, text) TO rawr_app;
