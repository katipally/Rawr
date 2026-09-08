-- Testing a second subject line on an email step.
--
-- Only the subject, deliberately. Two whole bodies is a different feature: it
-- doubles what a reader has to hold in their head to know what a sequence says,
-- and the subject is the line that decides whether the rest is read at all.
--
-- NULL means no test, which is what every existing step is and what a new one is
-- until somebody types a second line.

ALTER TABLE public.sequence_step ADD COLUMN subject_b text;
--> statement-breakpoint

-- Which line actually went out. Stored rather than recomputed, so comparing the
-- two is a group-by rather than a hash repeated in SQL, and so a step edited
-- later cannot rewrite the history of what was sent.
ALTER TABLE public.sequence_send ADD COLUMN variant text;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
