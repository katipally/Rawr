-- A contract on a deal, a deck on a company.
--
-- Rawr has held files since F1, but only ever ones that arrived attached to an
-- email: message_attachment belongs to a message and cannot be put on a record.
-- The thing a salesperson actually asks for is the signed order form on the deal
-- it closed.
--
-- The bytes are not here. This row names a file in object storage and says who
-- put it there; a database is the wrong place to keep a forty megabyte PDF, and
-- keeping one there would put it in every backup and every replica of the rows
-- somebody actually queries.
--
-- Nor does the file pass through the app. The browser is handed a signed URL and
-- uploads straight to storage, which is why a large file cannot occupy a request
-- worker for a minute, and reads are signed links that expire rather than a
-- public bucket that never does.

CREATE TABLE "attachment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  -- Which record it is on. Not a foreign key: entity_type decides which table it
  -- points at, and Postgres has no constraint that spans three of them. The same
  -- shape activity_link and task already use.
  "entity_type" "rawr_entity_type" NOT NULL,
  "entity_id" uuid NOT NULL,
  -- The path inside the bucket. Carries the workspace, so one tenant's prefix is
  -- never another's even if a bucket is ever shared or misconfigured.
  "storage_key" text NOT NULL,
  "filename" text NOT NULL,
  "bytes" bigint NOT NULL,
  "mime" text NOT NULL,
  -- Set null rather than cascade: a file outlives whoever uploaded it, and the
  -- record of it existing is the point.
  "uploaded_by" uuid REFERENCES "user_account"("id") ON DELETE SET NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- The only read: everything on one record, newest first.
CREATE INDEX "attachment_entity_idx"
    ON "attachment" ("workspace_id", "entity_type", "entity_id", "at" DESC);--> statement-breakpoint

-- One row per object. An upload that is retried writes the same key, and without
-- this the record would show the same file twice.
CREATE UNIQUE INDEX "attachment_storage_key"
    ON "attachment" ("workspace_id", "storage_key");
