-- Two more things the bell has to say about a task.
--
-- `task_overdue` is the only one that exists today, and it is the one nobody
-- asked for: it arrives after the moment has passed. A reminder is the notice a
-- person set for themselves, at the time they chose, before the task is due.
-- An assignment notice is the other half of handing work over: giving somebody a
-- task without telling them is how a queue fills with work nobody knows about.
--
-- Alone in this file because Postgres refuses to use an enum value in the
-- transaction that added it, and the migrator runs one transaction per file.
-- Everything that writes or reads these two is in 0070 and after.

ALTER TYPE public.rawr_notification_kind ADD VALUE IF NOT EXISTS 'task_reminder';
--> statement-breakpoint

ALTER TYPE public.rawr_notification_kind ADD VALUE IF NOT EXISTS 'task_assigned';
