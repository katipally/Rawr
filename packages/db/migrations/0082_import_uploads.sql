-- An import arrives in pieces and keeps the rows it refused.
--
-- The browser reads the file and sends its rows a batch at a time, so no request
-- carries the whole thing and no host or proxy puts a ceiling on how big it can
-- be. Until the last batch lands the run is 'uploading', which the mapper, the
-- preview and the worker all leave alone.
--
-- A refused row stays in import_row with the reason it was refused, so the error
-- file is every refused row rather than the first thousand kept on the run.

ALTER TYPE "public"."rawr_import_state" ADD VALUE IF NOT EXISTS 'uploading' BEFORE 'mapping';--> statement-breakpoint
ALTER TABLE "import_row" ADD COLUMN IF NOT EXISTS "reason" text;
