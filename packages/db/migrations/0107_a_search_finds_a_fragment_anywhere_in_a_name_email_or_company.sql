-- The list search matched whole words, so "stale" never found audit-c2-stale@example.test:
-- an email is one word. A search now finds any fragment of a record's text, ignoring case.
--
-- No trigram index. Row security stops the planner from driving an index scan with ILIKE,
-- because ILIKE is not leakproof, so an index on the text would only slow writes.
--
-- A custom record has no columns of its own, so its text is written to search_text on
-- every write, the same way its word vector is. Backfilled here from the fields each
-- object defines, so a record made before this release is found too.

ALTER TABLE public.custom_record ADD COLUMN IF NOT EXISTS search_text text;--> statement-breakpoint

UPDATE public.custom_record AS r
   SET search_text = coalesce((
         SELECT string_agg(r.custom ->> f.key, ' ')
           FROM public.field_def AS f
          WHERE f.object_id = r.object_id
            AND f.deleted_at IS NULL
            AND f.type IN ('text', 'long_text', 'rich_text', 'email', 'phone', 'url', 'linkedin', 'address', 'select')
       ), '');
