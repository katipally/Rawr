-- Months of raw page views. A data-protection decision, so the company owns it
-- rather than an environment variable shared by every tenant on a deployment.
-- 25 is what ACTIVITY_RETENTION_MONTHS shipped with, so behaviour is unchanged.
ALTER TABLE public.organisation
  ADD COLUMN activity_retention_months integer NOT NULL DEFAULT 25;
--> statement-breakpoint

ALTER TABLE public.organisation
  ADD CONSTRAINT organisation_activity_retention_months_check
  CHECK (activity_retention_months BETWEEN 1 AND 120);
