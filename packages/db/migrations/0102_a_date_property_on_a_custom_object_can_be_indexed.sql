-- A date or datetime property of a custom object could not be indexed. Its filters,
-- sorts and calendar read the value as `(custom ->> key)::date` or `::timestamptz`,
-- and Postgres refuses those in an index expression: turning text into either
-- depends on the session's DateStyle and TimeZone, so the cast is not IMMUTABLE and
-- an index built on it could disagree with itself.
--
-- These two functions read only the one format Rawr writes and nothing the session
-- can change, so declaring them IMMUTABLE is true:
--   stored_date          'YYYY-MM-DD'
--   stored_timestamptz   'YYYY-MM-DD"T"HH24:MI[:SS[.fff]]' with a trailing 'Z' or
--                        '+HH[:MM]' / '-HH[:MM]'. A value with no zone is UTC.
-- A date is written as 'YYYY-MM-DD' and a moment as the ISO string of a JavaScript
-- Date (UTC, milliseconds, 'Z'). The year is read as written, the offset is applied
-- by arithmetic, and the result is placed on the UTC clock by name, so no setting
-- of the session is consulted.
--
-- A value in neither shape, or a day that does not exist (2026-02-30, hour 24), is
-- NULL, which reads as an empty property. The cast it replaces raised an error for
-- such a value, so one bad row stopped every list, board and calendar that touched
-- it and would have failed an index build half way. Nothing here raises. The
-- digits are matched as [0-9] because \d can match other scripts' digits in some
-- locales, and those would raise in the integer cast.
--
-- Only functions are created: no table is read or locked and no row is rewritten.
-- Run this before the release that queries through them, or a date property of a
-- custom object fails to load until it has run.
CREATE OR REPLACE FUNCTION public.stored_date(value text) RETURNS date
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN NOT p.ok THEN NULL
    WHEN p.y < 1 OR p.m NOT BETWEEN 1 AND 12 THEN NULL
    WHEN p.d NOT BETWEEN 1 AND (make_date(p.y, p.m, 1) + interval '1 month')::date - make_date(p.y, p.m, 1) THEN NULL
    ELSE make_date(p.y, p.m, p.d)
  END
  FROM (
    SELECT t[1]::int AS y, t[2]::int AS m, t[3]::int AS d, t IS NOT NULL AS ok
      FROM (SELECT regexp_match(value, '^([0-9]{4})-([0-9]{2})-([0-9]{2})$') AS t) AS r
  ) AS p
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.stored_timestamptz(value text) RETURNS timestamptz
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE
    WHEN NOT p.ok THEN NULL
    WHEN p.day IS NULL OR p.h > 23 OR p.mi > 59 OR p.s >= 60 OR p.oh > 23 OR p.om > 59 THEN NULL
    ELSE (
      p.day + make_interval(hours => p.h, mins => p.mi, secs => p.s)
      + CASE WHEN p.sign = '-' THEN 1 ELSE -1 END * make_interval(hours => p.oh, mins => p.om)
    ) AT TIME ZONE 'UTC'
  END
  FROM (
    SELECT t IS NOT NULL AS ok,
           public.stored_date(t[1] || '-' || t[2] || '-' || t[3]) AS day,
           t[4]::int AS h,
           t[5]::int AS mi,
           coalesce(t[6], '0')::int + ('0' || coalesce(t[7], '.0'))::double precision AS s,
           t[8] AS sign,
           coalesce(t[9], '0')::int AS oh,
           coalesce(t[10], '0')::int AS om
      FROM (
        SELECT regexp_match(
          value,
          '^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(\.[0-9]{1,9})?)?(?:Z|([+-])([0-9]{2})(?::?([0-9]{2}))?)?$'
        ) AS t
      ) AS r
  ) AS p
$$;
