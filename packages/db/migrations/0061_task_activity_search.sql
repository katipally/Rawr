-- The top bar searched records and nothing else, so the two things people look
-- for by memory were the two it could not find: a task by its title, and a note
-- or a call by what was said in it.
--
-- Tasks get a trigram index only. A title is short and typed from memory, which
-- is what trigram is for, and a second vector over one column would buy nothing
-- a similarity match does not already give.
--
-- Activities get a generated vector over subject and body. Generated rather than
-- written on the write path, like contact, company and deal and unlike
-- custom_record: which columns name an activity is fixed here, not a registry
-- answer, so there is nothing for application code to keep in step.
ALTER TABLE "activity" ADD COLUMN IF NOT EXISTS "search" tsvector
  GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("subject", '') || ' ' || coalesce("body", ''))) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_search_idx" ON "activity" USING gin ("search");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_title_trgm_idx" ON "task" USING gin ("title" extensions.gin_trgm_ops);
