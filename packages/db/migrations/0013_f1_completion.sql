-- F1 completion: segments become a real feature, and two seeded field labels are
-- corrected. Nothing here drops data.

-- A segment needs somewhere to say what it is for, and somewhere to record when it
-- was last recomputed, so the UI can say "not evaluated yet" instead of showing a
-- member count of zero that means "unknown".
ALTER TABLE segment ADD COLUMN IF NOT EXISTS description text;
--> statement-breakpoint
ALTER TABLE segment ADD COLUMN IF NOT EXISTS last_evaluated_at timestamptz;
--> statement-breakpoint

-- The exit query filters on this on every evaluation, and the membership read on
-- the record page filters on it too. Partial, because the rows that matter are the
-- live ones and a long-lived workspace accumulates far more closed spells.
CREATE INDEX IF NOT EXISTS segment_membership_live_idx
  ON segment_membership (workspace_id, segment_id, entity_id)
  WHERE exited_at IS NULL;
--> statement-breakpoint

-- Two labels on the contact panel both read "Original source", which made the pair
-- unreadable. lead_source is the sales-owned select; original_source is the
-- attribution container. Only the seeded values are touched, so a workspace that
-- has renamed either keeps its own wording.
UPDATE field_def SET label = 'Lead source'
 WHERE key = 'lead_source' AND label = 'Original source';
--> statement-breakpoint

UPDATE field_def SET label = 'Original source'
 WHERE key = 'original_source' AND label = 'Original source details';
--> statement-breakpoint

UPDATE field_def SET label = 'Latest source'
 WHERE key = 'latest_source' AND label = 'Latest source details';
--> statement-breakpoint

SELECT rawr.apply_tenancy();
