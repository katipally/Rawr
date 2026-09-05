-- Objects an admin invents, and somewhere to keep their rows.
--
-- object_def has always been able to describe an object. What a custom one had
-- no answer for is where its records live: contact, company and deal are real
-- tables whose names are interpolated into SQL in thirty-odd places, and a
-- fourth object had no table to be interpolated.
--
-- One shared table, keyed by which object each row belongs to, with the values
-- in a jsonb blob. That is not a new idea here: it is exactly how a cold custom
-- field is already stored on a core record, applied one level up — from fields
-- to whole objects. The alternative was issuing CREATE TABLE at runtime, which
-- performs better and sits badly beside a migrations folder, cannot be described
-- to drizzle, and turns a failed statement into a half-made object.
--
-- The core three keep their own tables and lose nothing: their columns, their
-- indexes and their generated search vectors are untouched by this.
--
-- The cost, stated plainly: a custom object's field can never be promoted to a
-- hot column, so a very large custom object sorts and filters more slowly than
-- contacts do. Everything here is a jsonb expression, and the index below is a
-- GIN over the blob rather than a btree over a column.

CREATE TABLE "custom_record" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  -- Which object this row is one of. Deleting the object takes its records, the
  -- way dropping a table would have.
  "object_id" uuid NOT NULL REFERENCES "object_def"("id") ON DELETE CASCADE,
  -- Every value, including the one that names the record. A core record splits
  -- these between columns and `custom`; a custom record has only the blob.
  "custom" jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Set by the layer on write rather than generated, because what a record is
  -- called is a field the admin chose and Postgres cannot know which key that is
  -- from inside a generated expression.
  "search" tsvector,
  "owner_id" uuid REFERENCES "user_account"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Soft delete, matching every other record table: a deletion must not take the
  -- history on the records it touched.
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

-- The list: one object's live rows, newest first. Partial on deleted_at so the
-- index is the size of what is on screen rather than of everything ever made.
CREATE INDEX "custom_record_object_idx"
    ON "custom_record" ("workspace_id", "object_id", "created_at" DESC)
 WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- Filtering and sorting on a jsonb key. A GIN over the blob is what makes a
-- containment or existence test on any field indexable without a column per
-- field, which is the trade this table makes.
CREATE INDEX "custom_record_values_idx"
    ON "custom_record" USING gin ("custom" jsonb_path_ops);--> statement-breakpoint

CREATE INDEX "custom_record_search_idx"
    ON "custom_record" USING gin ("search");
