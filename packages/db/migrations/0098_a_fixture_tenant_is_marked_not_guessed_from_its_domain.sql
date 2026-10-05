-- The worker stepped over the suites' fixture tenants by matching their email
-- domain against '%.test'. A string match on a domain decides whether a customer's
-- imports run, and a real tenant on any such domain would silently never be worked.
-- The tenants the seed builds say so themselves instead.
--
-- The existing fixtures are the accounts on a reserved '.test' domain, which is
-- the only thing the old match ever selected, so this changes nothing for them.
-- A small table with a constant default: no rewrite, no noticeable lock.
ALTER TABLE public.account ADD COLUMN IF NOT EXISTS is_fixture boolean NOT NULL DEFAULT false;
--> statement-breakpoint

UPDATE public.account SET is_fixture = true WHERE google_hosted_domain LIKE '%.test';
