-- The other direction.
--
-- Rawr has taken webhooks from four providers since F6, with signature checks, a
-- replay window, an idempotency key and a dead letter behind them. Nothing could
-- subscribe to Rawr. Anything wanting to know that a deal moved had to poll, and
-- the only thing to poll was a tRPC endpoint meant for the app's own screens.
--
-- This is that same machinery pointed outward, and deliberately little of it is
-- new. A delivery is sent the way the Slack notifications are: off the request,
-- and recorded as a dead letter if it fails, so the Failed jobs screen lists it
-- and replays it with no new queue and no new screen. What is new is only who to
-- tell and the key that proves it was us.

CREATE TABLE "webhook_endpoint" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  -- https only, enforced in the layer. A plaintext endpoint would put the record
  -- on the wire for anyone on the path, and the signature proves who sent it,
  -- not that nobody read it.
  "url" text NOT NULL,
  -- The signing key. Shown once when it is created or rolled, the way the agent
  -- token is: a secret a screen can redisplay is a secret in a screenshot.
  "secret" text NOT NULL,
  -- Which events this one wants, as "contact.created", "deal.stage_changed".
  -- Empty means every event, which is what somebody piping Rawr into a warehouse
  -- actually wants and saves them re-editing the list as events are added.
  "events" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "is_active" boolean NOT NULL DEFAULT true,
  -- The same four health columns an integration carries, for the same reason: a
  -- subscriber that quietly stopped receiving is the failure that matters, and
  -- it is invisible without somewhere to write the last answer.
  "last_ok_at" timestamp with time zone,
  "last_status" integer,
  "last_error" text,
  "last_error_at" timestamp with time zone,
  "created_by" uuid REFERENCES "user_account"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- The dispatcher's read: every live endpoint for the workspace an event happened
-- in. Few enough per workspace that which events each wants is decided in the
-- app rather than by a query per event.
CREATE INDEX "webhook_endpoint_live_idx"
    ON "webhook_endpoint" ("workspace_id", "is_active");
