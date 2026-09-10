-- Enrollments that can never send, and what stops them coming back.
--
-- Five enrollments in production had no mailbox and no way to get one: the
-- mailbox row was deleted while they were live, the foreign key nulled the
-- column, and the claim then took a lease, found no sender, and returned without
-- releasing it. Once a minute, for ever, the worker logged "Not due, or already
-- being run" and moved on. The claim now stops such an enrollment where it finds
-- it; this fails the ones already in that state.
--
-- The reasons are written the way a person would read them on the record: what
-- happened, why it stopped rather than retried, and what to do about it.

WITH ended AS (
  UPDATE public.sequence_enrollment e
     SET state = 'failed',
         stop_reason = CASE
           WHEN e.mailbox_id IS NULL THEN
             'The mailbox this enrollment was sending from is gone. Nothing can go out from an enrollment with no sender, so it is stopped rather than claimed again every minute. Enroll the contact again from a connected mailbox.'
           ELSE
             'This contact has no email address any more. A step cannot be sent to nobody, so the enrollment is stopped rather than claimed again every minute. Put an address back on the record and enroll them again.'
         END,
         next_run_at = NULL,
         lease_until = NULL,
         finished_at = now()
    FROM public.contact c
   WHERE c.id = e.contact_id
     AND e.state IN ('active', 'waiting_task')
     AND (e.mailbox_id IS NULL OR c.email IS NULL OR btrim(c.email) = '')
  RETURNING e.account_id, e.id, e.stop_reason
)
-- The same ledger row the engine writes whenever an enrollment stops, so the
-- timeline of one of these reads like any other stopped enrollment.
INSERT INTO public.sequence_event (account_id, enrollment_id, kind, detail)
SELECT account_id, id, 'stopped', jsonb_build_object('state', 'failed', 'reason', stop_reason)
  FROM ended;

--> statement-breakpoint
-- The worker's dispatch scans every tenant's queue at once, so it cannot use
-- sequence_enrollment_due_idx: account_id leads that one. Without this the sweep
-- is a sequential scan of the table once a minute.
CREATE INDEX IF NOT EXISTS sequence_enrollment_queue_idx
  ON public.sequence_enrollment (next_run_at)
  WHERE state = 'active';

--> statement-breakpoint
-- One row per message the provider actually accepted. A retry that got as far as
-- sending records nothing a second time, so a report cannot count one mail twice.
-- Sequence sends only: a mail sent by hand has no step to repeat.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_send_provider_key
  ON public.sequence_send (account_id, provider_message_id)
  WHERE enrollment_id IS NOT NULL AND provider_message_id IS NOT NULL;

--> statement-breakpoint
-- A failure that was never a queued job has no attempts. Nought would read as
-- "tried nothing and gave up"; null is "this never reached a queue", which the
-- failed-jobs table renders as "not queued".
ALTER TABLE public.dead_letter ALTER COLUMN attempts DROP NOT NULL;

--> statement-breakpoint
ALTER TABLE public.dead_letter ALTER COLUMN attempts DROP DEFAULT;

--> statement-breakpoint
COMMENT ON COLUMN public.dead_letter.attempts IS
  'How many times the job was tried. Null when the failure was never a queued job at all.';
