-- A7: full text finds what was spelled right, trigram finds what was not. Both are
-- needed because the names being searched are people and companies, which are
-- typed from memory.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contact_name_trgm_idx" ON "contact" USING gin ((coalesce(first_name, '') || ' ' || coalesce(last_name, '')) extensions.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_name_trgm_idx" ON "company" USING gin (coalesce(name, '') extensions.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deal_name_trgm_idx" ON "deal" USING gin (coalesce(name, '') extensions.gin_trgm_ops);--> statement-breakpoint
-- Prefix matching on the two identifiers people paste. lower() rather than ilike so
-- the index is usable.
CREATE INDEX IF NOT EXISTS "contact_email_prefix_idx" ON "contact" (lower(email) text_pattern_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_domain_prefix_idx" ON "company" (lower(domain) text_pattern_ops);
