-- mcp_client was the one public table with no row level security on it.
--
-- rawr.apply_tenancy() protects every table that has a workspace_id column, and
-- mcp_client deliberately has none: an OAuth client is a public name and a
-- redirect list, shared by every tenant that connects with it. So the loop never
-- reached it and it was left open, which the tenancy suite reports as an
-- offender. workspace and user_account are in the same position and each carries
-- a hand-written policy in 0001; this is the one that was missed.
--
-- The policy is permissive because the table really is global. That is the point
-- of writing it down: "every row is readable here" becomes a decision stated in
-- SQL that the suite can check, rather than an omission that looks identical to
-- one from the outside.

ALTER TABLE public.mcp_client ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.mcp_client FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rawr_global ON public.mcp_client;
--> statement-breakpoint
CREATE POLICY rawr_global ON public.mcp_client USING (true) WITH CHECK (true);
