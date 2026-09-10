-- A rule can fork, so "how far it got" stops being a number.
--
-- Steps were a flat list and a parked run remembered one integer. A branch makes
-- the list a tree: step 2 may be "if they opened it, do these three things,
-- otherwise do those two", and a run parked inside the other road is at
-- [2, "otherwise", 1]. An integer cannot say that, so the column becomes the path
-- from the root, and a path of one element is exactly what every existing run
-- already meant.
--
-- The backfill is therefore total: every run in the table today is at the top
-- level, and jsonb_build_array(step_index) is the same position written the new
-- way. Nothing is lost, so the old column goes rather than being left to drift.
--
-- scan_day is the other half of the same change. The two new triggers are found
-- by an hourly scan rather than announced by a write, and a scan that runs twelve
-- times before midnight must not fire a rule twelve times. The unique index is
-- what enforces once per rule, per record, per day; it covers only scanned runs,
-- because a rule triggered by an event legitimately fires as often as the event
-- happens.

ALTER TABLE "automation_run" ADD COLUMN "step_path" jsonb DEFAULT '[]'::jsonb NOT NULL;

UPDATE "automation_run" SET "step_path" = jsonb_build_array("step_index");

ALTER TABLE "automation_run" DROP COLUMN "step_index";

ALTER TABLE "automation_run" ADD COLUMN "scan_day" date;

CREATE UNIQUE INDEX IF NOT EXISTS "automation_run_scan_idx"
    ON "automation_run" ("account_id", "automation_id", "entity_id", "scan_day")
 WHERE "scan_day" is not null;
