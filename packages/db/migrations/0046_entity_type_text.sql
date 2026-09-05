-- An entity is any object, not one of three.
--
-- `rawr_entity_type` was an enum of contact, company and deal, and it is what
-- activity_link, association, task, attachment and automation_run all point at.
-- That made it the single reason a custom object was an island: it had records,
-- fields, a list and a record page, and no timeline, no associations, no tasks
-- and no files, because none of those could name it.
--
-- The enum cannot simply gain values. A custom object's key is whatever an admin
-- named it, invented long after this migration ran, and ALTER TYPE at runtime is
-- the CREATE TABLE problem again one level down. So the column becomes text and
-- `object_def` becomes what says which keys exist, which is already true of every
-- other place a key is resolved: the registry, not the catalog.
--
-- What is given up is the catalog rejecting a typo. What replaces it is the data
-- access layer, which is the only way into these tables and which resolves the
-- object through the registry before it writes. The same trade `field_def` keys
-- have always made.
--
-- import_job.object_type is deliberately left on the enum: importing into a
-- custom object is not built, so that column genuinely does hold one of three,
-- and the type stays alive for it.

ALTER TABLE "activity_link"  ALTER COLUMN "entity_type" TYPE text USING "entity_type"::text;--> statement-breakpoint
ALTER TABLE "association"    ALTER COLUMN "from_type"   TYPE text USING "from_type"::text;--> statement-breakpoint
ALTER TABLE "association"    ALTER COLUMN "to_type"     TYPE text USING "to_type"::text;--> statement-breakpoint
ALTER TABLE "task"           ALTER COLUMN "entity_type" TYPE text USING "entity_type"::text;--> statement-breakpoint
ALTER TABLE "attachment"     ALTER COLUMN "entity_type" TYPE text USING "entity_type"::text;--> statement-breakpoint
ALTER TABLE "automation_run" ALTER COLUMN "entity_type" TYPE text USING "entity_type"::text;
