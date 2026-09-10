-- Deal score: how healthy a deal looks, 0 to 100.
--
-- HubSpot's `hs_deal_score` is an opaque AI number. This one is six rules with
-- fixed weights, so `score_detail` can carry what each rule contributed and the
-- record page can show a rep why the number is what it is. A score nobody can
-- argue with is a score nobody trusts.
--
-- `score_at` is the stamp, because the number is recomputed nightly and on a
-- stage change rather than on read: it costs a pass over the timeline, the
-- associations and the pipeline median, which is not work a board render can do.

ALTER TABLE "deal" ADD COLUMN "score" integer;--> statement-breakpoint
ALTER TABLE "deal" ADD COLUMN "score_at" timestamptz;--> statement-breakpoint
ALTER TABLE "deal" ADD COLUMN "score_detail" jsonb;--> statement-breakpoint

-- Sorting a list by score, and the "weakest deals first" read that follows from
-- having one at all.
CREATE INDEX "deal_score_idx" ON "deal" ("account_id", "score" DESC NULLS LAST);--> statement-breakpoint

-- Every surface reads, filters, sorts and exports through the registry, so a
-- column with no field_def row is a column nobody can see. Provisioning gives new
-- accounts theirs; this gives the ones that already exist the same row. The key
-- is in SYSTEM_FIELD_KEYS, so it is readable everywhere and refused on every
-- write path: nobody hand-edits a computed score.
INSERT INTO "field_def" ("account_id", "object_id", "key", "label", "type", "storage", "column_name", "is_custom", "is_required", "position")
SELECT o."account_id", o."id", 'score', 'Deal score', 'number', 'column', 'score', false, false, 16
  FROM "object_def" o
 WHERE o."key" = 'deal'
   AND NOT EXISTS (
     SELECT 1 FROM "field_def" f WHERE f."account_id" = o."account_id" AND f."object_id" = o."id" AND f."key" = 'score'
   );
