-- Two triggers that are not events.
--
-- Every trigger until now was something Rawr already emitted on a write, which is
-- why nothing polled. These two are the ones teams ask for that no write can
-- announce:
--
--   date_reached  three days before the close date, on the renewal date, a week
--                 after the trial started. HubSpot calls this a scheduled
--                 enrollment trigger and offers On date / Before date / After
--                 date against any date property; this is the same shape.
--   no_activity   nothing has happened on this record for N days. HubSpot writes
--                 it as a filter on last activity date; here it is its own
--                 trigger because it needs the same hourly scan date_reached
--                 does, and neither can arrive on a write.
--
-- Alone in this file because Postgres refuses to use an enum value in the same
-- transaction that added it, and the migrator runs one transaction per file.
-- Everything that reads them is in 0068 and after. Same reason as 0039.

ALTER TYPE "rawr_automation_trigger" ADD VALUE IF NOT EXISTS 'date_reached';
ALTER TYPE "rawr_automation_trigger" ADD VALUE IF NOT EXISTS 'no_activity';
