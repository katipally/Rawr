-- A third way to look at a list.
--
-- A table answers "what is there", a board answers "what stage is it at", and
-- neither answers "what is happening this month" — which for deals closing and
-- tasks falling due is the question somebody opens the CRM to ask.
--
-- No new column. A calendar needs to know which field puts a record on a day,
-- and `group_by_field_id` already means exactly that: which field organises this
-- view. A board points it at a stage, a calendar points it at a date.
--
-- Alone in its file: Postgres will not use an enum value in the transaction that
-- added it, and the migrator runs one transaction per file.

ALTER TYPE "rawr_view_kind" ADD VALUE IF NOT EXISTS 'calendar' AFTER 'board';
