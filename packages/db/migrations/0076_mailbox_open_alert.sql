-- The bell entry behind "tell me when a mail I sent is opened".
--
-- Alone in this file because Postgres refuses to use an enum value in the
-- transaction that added it, and the migrator runs one transaction per file. The
-- column that turns the alert on, `mailbox.alert_on_open`, is in 0074 alongside
-- the campaign table; everything that writes this kind is in the code that runs
-- after both.
--
-- One notice per message, not per fetch: the pixel is deliberately counted every
-- time it is read, and Apple Mail Privacy Protection reads it on its own
-- schedule, so a notice per open would be a stream of noise about one mail. The
-- dedupe key is the send, so the second and later opens raise the count on the
-- notice already there rather than adding another.

ALTER TYPE public.rawr_notification_kind ADD VALUE IF NOT EXISTS 'email_opened';
