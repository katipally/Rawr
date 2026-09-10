-- Three hundred and seventy-two properties on one object is the case that decides
-- whether the settings screen is usable, and two columns are what make it so.
--
-- `conditional` is the rule that keeps a property off the screen until it is
-- relevant, in the shape the filter builder already produces and a segment
-- already stores: one group of conditions over sibling properties. HubSpot calls
-- it conditional property logic and enforces it wherever a record is created or
-- edited by hand, and not where a job writes; so does Rawr.
--
-- `filled_count` and `filled_at` are the fill rate, cached. Counting how many of
-- eighty-eight thousand contacts hold a value for each of three hundred and
-- seventy-two properties is one scan per property, so the screen cannot do it on
-- render. A nightly job does it once per object and stamps when, and the stamp is
-- what lets the number say how old it is instead of pretending to be live.

ALTER TABLE "field_def" ADD COLUMN "conditional" jsonb;--> statement-breakpoint
ALTER TABLE "field_def" ADD COLUMN "filled_count" integer;--> statement-breakpoint
ALTER TABLE "field_def" ADD COLUMN "filled_at" timestamptz;
