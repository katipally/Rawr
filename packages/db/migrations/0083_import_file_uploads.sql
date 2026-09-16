-- The file arrives whole, and the server reads it.
--
-- Before this the browser parsed the file and sent its rows a batch at a time,
-- which meant the tab had to stay open for the length of the upload and a closed
-- one stranded whatever had landed. Now the browser sends the bytes to storage a
-- part at a time and stops there: the server opens the object, reads it into
-- rows and moves the run on to the mapper by itself.
--
-- A part is remembered by number, so an upload resumed after a closed tab sends
-- the parts that are missing and no others.

ALTER TYPE "public"."rawr_import_state" ADD VALUE IF NOT EXISTS 'parsing' AFTER 'uploading';--> statement-breakpoint
ALTER TABLE "import_run" ADD COLUMN IF NOT EXISTS "upload_key" text;--> statement-breakpoint
ALTER TABLE "import_run" ADD COLUMN IF NOT EXISTS "upload_id" text;--> statement-breakpoint
ALTER TABLE "import_run" ADD COLUMN IF NOT EXISTS "upload_parts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "import_run" ADD COLUMN IF NOT EXISTS "uploaded_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_run" ADD COLUMN IF NOT EXISTS "file_bytes" bigint DEFAULT 0 NOT NULL;
