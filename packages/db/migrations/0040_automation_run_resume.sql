-- What a run needs in order to survive a wait. See 0039 for why this is split.

ALTER TABLE "automation" ADD COLUMN "steps" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint

-- Every existing rule is a run of actions with no waiting in it, which is exactly
-- what it was before. Nothing changes shape for a rule already switched on.
UPDATE "automation"
   SET "steps" = (
     SELECT coalesce(jsonb_agg(jsonb_build_object('kind', 'action') || a ORDER BY ord), '[]'::jsonb)
       FROM jsonb_array_elements("actions") WITH ORDINALITY AS t(a, ord)
   )
 WHERE jsonb_typeof("actions") = 'array' AND jsonb_array_length("actions") > 0;--> statement-breakpoint

ALTER TABLE "automation" DROP COLUMN "actions";--> statement-breakpoint

-- Where to pick up. A run that finished in one pass never leaves zero, so the
-- column reads as "how far it got" for a failure too.
ALTER TABLE "automation_run" ADD COLUMN "step_index" integer NOT NULL DEFAULT 0;--> statement-breakpoint
-- When to come back. Null on every run that is not waiting, which is what the
-- dispatcher's index is built on: the queue, not the history.
ALTER TABLE "automation_run" ADD COLUMN "resume_at" timestamp with time zone;--> statement-breakpoint
-- Held while a resume is in flight, so two workers cannot advance one run twice.
ALTER TABLE "automation_run" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
-- What the finished steps did, kept across a wait: the detail of a run that spans
-- three days is written in three pieces, and `detail` is one string.
ALTER TABLE "automation_run" ADD COLUMN "trail" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint

-- The dispatcher's index, and the size of the queue rather than of every run that
-- ever happened. On resume_at rather than on the state, because a null there is
-- the same fact and needs no enum in the predicate.
CREATE INDEX "automation_run_due_idx"
    ON "automation_run" ("workspace_id", "resume_at")
 WHERE "resume_at" IS NOT NULL;
