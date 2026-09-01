-- F6. The integration framework: idempotency out, deduplication in, provenance on
-- every enriched value, and the suggestions enrichment was not allowed to write.

CREATE TYPE "rawr_field_source" AS ENUM ('human', 'import', 'enrichment', 'form', 'booking', 'product');
--> statement-breakpoint

-- An idempotency key per outbound call. Derived from what is being sent, never
-- random: a retry must produce the same key or it is not idempotent. F6 §1.
CREATE TABLE "outbound_call" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "integration_id" uuid REFERENCES "integration"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "operation" text NOT NULL,
  "response" jsonb,
  "at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_call_key" ON "outbound_call" ("workspace_id", "idempotency_key");
--> statement-breakpoint

-- Inbound webhooks, deduplicated on the provider's own event id. F6 §1.
CREATE TABLE "inbound_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "source" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL,
  "contact_id" uuid,
  "matched" boolean DEFAULT false NOT NULL,
  "at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_event_key"
  ON "inbound_event" ("workspace_id", "source", "provider_event_id");
--> statement-breakpoint
-- The unmatched queue: an event for an address nobody knows is kept and surfaced,
-- never dropped. F6 §3.
CREATE INDEX "inbound_event_unmatched_idx"
  ON "inbound_event" ("workspace_id", "matched", "at" DESC);
--> statement-breakpoint

-- Where a value came from. Enrichment fills blanks and updates values whose
-- provenance is itself enrichment; it never overwrites 'human'. F6 §4.
CREATE TABLE "field_source" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "entity" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "field_key" text NOT NULL,
  "source" "rawr_field_source" NOT NULL,
  "provider" text,
  "at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "field_source_key"
  ON "field_source" ("workspace_id", "entity", "entity_id", "field_key");
--> statement-breakpoint

-- What enrichment suggested and was refused. "Not written" must not mean "never
-- seen": a human decides. F6's edge-case table.
CREATE TABLE "enrichment_suggestion" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspace"("id") ON DELETE CASCADE,
  "entity" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "field_key" text NOT NULL,
  "suggested" text NOT NULL,
  "current" text,
  "provider" text NOT NULL,
  "at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "enrichment_suggestion_key"
  ON "enrichment_suggestion" ("workspace_id", "entity", "entity_id", "field_key");
--> statement-breakpoint
CREATE INDEX "enrichment_suggestion_entity_idx"
  ON "enrichment_suggestion" ("workspace_id", "entity", "entity_id");
--> statement-breakpoint

-- The provider's own id for a contact, so the Brevo sync is incremental rather
-- than a full re-push, and a Rawr opt-out can be propagated to the right record.
ALTER TABLE "contact" ADD COLUMN IF NOT EXISTS "external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "external_ids" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint

SELECT rawr.apply_tenancy();
