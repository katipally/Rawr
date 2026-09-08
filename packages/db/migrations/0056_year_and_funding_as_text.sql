-- HubSpot types both Year Founded and Total Money Raised as single-line text,
-- and that is the right shape for what providers actually return: Lusha answers
-- "$10M" and a range, Apollo answers a number, and the honest thing is to keep
-- what was said rather than parse it into a false precision. It also stops a
-- year rendering as "2,015", which is what a number field does to four digits.

-- trim_scale drops the decimal tail a numeric carries, so 42000000.00 becomes
-- 42000000 rather than reading as cents nobody entered.
ALTER TABLE public.company
  ALTER COLUMN founded_year TYPE text USING founded_year::text,
  ALTER COLUMN funding_raised TYPE text USING trim_scale(funding_raised)::text;
--> statement-breakpoint

UPDATE public.field_def f
   SET type = 'text'
  FROM public.object_def o
 WHERE o.id = f.object_id
   AND o.key = 'company'
   AND f.key IN ('founded_year', 'funding_raised');
