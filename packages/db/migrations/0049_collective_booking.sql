-- Meetings that commit more than one person.
--
-- Round robin unions its hosts' availability: the slot is offered if anybody can
-- take it. A collective intersects it: the meeting is the whole panel, so a time
-- with one of them missing is not that meeting. That is the only difference in
-- how the two are computed, so it is one more value on the existing enum rather
-- than a second kind of page.
--
-- booking_participant is the other half. `booking.host_user_id` stays the
-- organiser -- whose Zoom it is, who owns the lead, whose name the confirmation
-- says -- and this table records everybody the meeting actually commits. Its
-- unique index is what makes a double booking unreachable for a panellist who
-- did not organise the meeting, which the index on `booking` alone could never
-- do. One meeting stays one row in `booking`, one timeline entry, one contact.
--
-- Rows exist only while a booking is confirmed. Cancelling or moving one deletes
-- them, which is what frees the time again and why the index needs no partial
-- clause.

ALTER TYPE public.rawr_booking_kind ADD VALUE IF NOT EXISTS 'collective';
--> statement-breakpoint

-- Collective only, and true is the answer for every existing row: on the other
-- kinds each host stands alone and the column is not read.
ALTER TABLE public.booking_host
  ADD COLUMN IF NOT EXISTS is_required boolean NOT NULL DEFAULT true;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS public.booking_participant (
  workspace_id uuid NOT NULL REFERENCES public.workspace(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.booking(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.user_account(id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  -- The organiser's event is the one on `booking`; this is everybody else's, so
  -- a cancellation can withdraw each invitation rather than orphaning it.
  calendar_event_id text,
  calendar_id text,
  is_organiser boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, booking_id, user_id)
);
--> statement-breakpoint

-- The invariant, for everyone in the room.
CREATE UNIQUE INDEX IF NOT EXISTS booking_participant_slot_key
  ON public.booking_participant (workspace_id, user_id, starts_at);
--> statement-breakpoint

-- The overlap read: one person's commitments in a window.
CREATE INDEX IF NOT EXISTS booking_participant_window_idx
  ON public.booking_participant (workspace_id, user_id, starts_at, ends_at);
--> statement-breakpoint

-- Every confirmed booking already on the books. Without this the availability
-- engine, which now reads commitments from this table, would offer times that
-- are already taken the moment this migration lands.
INSERT INTO public.booking_participant
  (workspace_id, booking_id, user_id, starts_at, ends_at, calendar_event_id, calendar_id, is_organiser)
SELECT b.workspace_id, b.id, b.host_user_id, b.starts_at, b.ends_at,
       b.calendar_event_id, b.calendar_id, true
  FROM public.booking b
 WHERE b.state = 'confirmed'
ON CONFLICT DO NOTHING;
