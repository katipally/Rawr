-- The foreign key from activity_link to activity had no index that leads with
-- activity_id. Every index on this table leads with workspace_id, which serves
-- the timeline read but cannot serve the cascade: deleting an activity made
-- Postgres scan the whole of activity_link for each row. Found by the scale
-- suite, where deleting a hundred thousand segment_change entries hit the two
-- minute statement timeout inside the cascade rather than inside the delete.
--
-- This is the delete side of every merge, every erasure and every contact
-- removal, not just the scale script.

CREATE INDEX "activity_link_activity_idx" ON "activity_link" ("activity_id");
