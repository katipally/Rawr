-- F1 phase B. Gmail thread logging, read only.

CREATE TYPE "rawr_mailbox_state" AS ENUM ('connected', 'backfilling', 'revoked', 'error', 'paused');
--> statement-breakpoint
CREATE TYPE "rawr_message_direction" AS ENUM ('inbound', 'outbound');
--> statement-breakpoint
CREATE TYPE "rawr_message_role" AS ENUM ('from', 'to', 'cc');
--> statement-breakpoint

CREATE TABLE "mailbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "user_account"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "state" "rawr_mailbox_state" DEFAULT 'connected' NOT NULL,
  "access_token" text NOT NULL,
  "refresh_token" text NOT NULL,
  "access_token_expires_at" timestamptz,
  "history_id" text,
  "backfill_cursor" text,
  "backfill_done" boolean DEFAULT false NOT NULL,
  "last_sync_at" timestamptz,
  "last_error" text,
  "last_error_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_user_key" ON "mailbox" ("workspace_id", "user_id");
--> statement-breakpoint
CREATE INDEX "mailbox_state_idx" ON "mailbox" ("workspace_id", "state");
--> statement-breakpoint

CREATE TABLE "message_thread" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "provider" text DEFAULT 'gmail' NOT NULL,
  "provider_thread_id" text NOT NULL,
  "subject" text,
  "first_at" timestamptz,
  "last_at" timestamptz,
  "message_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Two mailboxes on the same thread store it once. F1 B's edge-case table.
CREATE UNIQUE INDEX "message_thread_provider_key"
  ON "message_thread" ("workspace_id", "provider", "provider_thread_id");
--> statement-breakpoint
CREATE INDEX "message_thread_last_idx" ON "message_thread" ("workspace_id", "last_at");
--> statement-breakpoint

CREATE TABLE "message" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "thread_id" uuid NOT NULL REFERENCES "message_thread"("id") ON DELETE CASCADE,
  "provider_message_id" text NOT NULL,
  "direction" "rawr_message_direction" NOT NULL,
  "from_addr" text,
  "to_addrs" text[] DEFAULT '{}' NOT NULL,
  "cc_addrs" text[] DEFAULT '{}' NOT NULL,
  "sent_at" timestamptz NOT NULL,
  "snippet" text,
  "body_ref" text,
  "has_attachments" boolean DEFAULT false NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- What makes an interrupted back-fill resumable with no duplicates. B2.
CREATE UNIQUE INDEX "message_provider_key" ON "message" ("workspace_id", "provider_message_id");
--> statement-breakpoint
CREATE INDEX "message_thread_idx" ON "message" ("workspace_id", "thread_id", "sent_at");
--> statement-breakpoint

CREATE TABLE "message_participant" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "message_id" uuid NOT NULL REFERENCES "message"("id") ON DELETE CASCADE,
  "address" text NOT NULL,
  "contact_id" uuid REFERENCES "contact"("id") ON DELETE SET NULL,
  "role" "rawr_message_role" NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "message_participant_key"
  ON "message_participant" ("workspace_id", "message_id", "address", "role");
--> statement-breakpoint
CREATE INDEX "message_participant_contact_idx"
  ON "message_participant" ("workspace_id", "contact_id");
--> statement-breakpoint

CREATE TABLE "message_blocklist" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "user_account"("id") ON DELETE CASCADE,
  "pattern" text NOT NULL,
  "note" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- NULLS NOT DISTINCT so the workspace-wide list cannot hold the same pattern twice.
CREATE UNIQUE INDEX "message_blocklist_key"
  ON "message_blocklist" ("workspace_id", "user_id", "pattern") NULLS NOT DISTINCT;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
