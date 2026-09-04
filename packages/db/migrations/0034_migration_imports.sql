-- B9. A HubSpot portal is more than its records. Eighty-eight thousand contacts
-- carry three hundred and seventy-two properties, sit in a hundred and twenty-nine
-- lists, and are linked to deals through an association table no record export
-- reproduces. None of that had an import path, so a cutover would have arrived
-- with the rows and none of the shape around them.

ALTER TYPE "public"."rawr_import_kind" ADD VALUE IF NOT EXISTS 'properties';--> statement-breakpoint
ALTER TYPE "public"."rawr_import_kind" ADD VALUE IF NOT EXISTS 'associations';--> statement-breakpoint
ALTER TYPE "public"."rawr_import_kind" ADD VALUE IF NOT EXISTS 'lists';--> statement-breakpoint
ALTER TYPE "public"."rawr_import_kind" ADD VALUE IF NOT EXISTS 'submissions';--> statement-breakpoint

-- An imported list has no filter that reproduces it. The hourly evaluator selects
-- every segment and rebuilds its membership from the query, so without this flag
-- the first run after an import would empty all hundred and twenty-nine of them.
ALTER TABLE "segment" ADD COLUMN IF NOT EXISTS "is_static" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- HubSpot groups its properties, and the group is the only thing that makes three
-- hundred and seventy-two of them navigable. Dropping it on import would be
-- lossless in the data and useless on the screen.
ALTER TABLE "field_def" ADD COLUMN IF NOT EXISTS "group_name" text;--> statement-breakpoint

-- Which import wrote this field, so a property that arrived from a portal can be
-- told apart from one somebody added here. Null for everything created by hand.
ALTER TABLE "field_def" ADD COLUMN IF NOT EXISTS "source" text;
