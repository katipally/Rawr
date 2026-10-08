-- The overdue next-step view listed deals that were already closed won or closed lost,
-- so the Monday chase asked people to follow up on deals that were finished. The Tasks
-- overdue list has always left them out. The view now leaves them out too.
--
-- Seeded views are copied into an account when it is provisioned, so a change to the
-- seed reaches new accounts only. This adds the condition to the view each existing
-- account already has. The condition is skipped where a stage condition is already
-- there, so a rerun changes nothing. It reads the stages when the view runs, so a stage
-- closed later is left out as well.

UPDATE public.saved_view AS v
   SET filters = v.filters || '[{"field":"stage_id","operator":"is","value":"@open_stage"}]'::jsonb,
       updated_at = now()
  FROM public.object_def AS o
 WHERE o.id = v.object_id
   AND o.key = 'deal'
   AND v.slug = 'overdue-next-step'
   AND NOT (v.filters @> '[{"field":"stage_id"}]'::jsonb);
