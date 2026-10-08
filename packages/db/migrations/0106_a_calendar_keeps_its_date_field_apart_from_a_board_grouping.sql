-- A board and a calendar shared one column. group_by_field_id held a stage for a board
-- and a date for a calendar, so saving one layout overwrote the other, and a view
-- opened in the other layout read a field of the wrong kind.
--
-- A calendar gets a column of its own. A board keeps group_by_field_id.
--
-- Until now the board could not save a grouping that was not a stage, so a value
-- naming a date field was a calendar's place-on field. Those move across and their
-- board slot is cleared. A value naming anything else was a board's grouping and stays.
-- The moved rows no longer name a field in group_by_field_id, so a rerun finds nothing.

ALTER TABLE public.saved_view ADD COLUMN IF NOT EXISTS calendar_field_id uuid;
--> statement-breakpoint

ALTER TABLE public.saved_view DROP CONSTRAINT IF EXISTS saved_view_calendar_field_id_field_def_id_fk;
--> statement-breakpoint
ALTER TABLE public.saved_view ADD CONSTRAINT saved_view_calendar_field_id_field_def_id_fk FOREIGN KEY (calendar_field_id) REFERENCES public.field_def(id) ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS saved_view_calendar_field_id_idx ON public.saved_view (calendar_field_id);
--> statement-breakpoint

-- updated_at moves too: an editor open on the calendar must see the view changed under it.
UPDATE public.saved_view AS v
   SET calendar_field_id = v.group_by_field_id,
       group_by_field_id = NULL,
       updated_at = now()
  FROM public.field_def AS f
 WHERE f.id = v.group_by_field_id
   AND f.type IN ('date', 'datetime');
