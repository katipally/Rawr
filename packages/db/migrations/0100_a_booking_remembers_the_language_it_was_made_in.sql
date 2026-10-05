-- A confirmation goes out the moment somebody books, in whatever form the server
-- chose to write the date: day-first in 24 hour time for everyone, a UK convention
-- imposed on every attendee. The reminders go out hours or days later from the
-- worker, which has no request to read the attendee's language from, so the booking
-- keeps it.
--
-- Null for the bookings made before this; their mail reads in the app's fallback.
-- A nullable column with no default: no rewrite, no noticeable lock.
ALTER TABLE public.booking ADD COLUMN IF NOT EXISTS attendee_locale text;
