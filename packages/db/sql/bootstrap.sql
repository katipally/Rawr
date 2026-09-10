-- What every migration after it assumes exists. Run by `pnpm db:migrate` before
-- the chain, because 0003 already creates an extension in the `extensions`
-- schema and 0004 already alters the `rawr_app` role.
--
-- Idempotent, so it is safe on a database that has been running for months. On
-- Supabase both objects already exist and every statement here is a no-op.

-- Supabase provides this schema; a plain Postgres does not. Extensions are kept
-- out of `public` either way, so an app role with write access to the schema its
-- tables live in cannot reach the extension functions.
CREATE SCHEMA IF NOT EXISTS extensions;

-- The role the application connects as. It owns no tables, has no BYPASSRLS, and
-- receives its grants from rawr.apply_tenancy(). NOLOGIN when no password is
-- given, so a fresh database is never briefly reachable by a role with none.
DO $$
DECLARE
  pw text := current_setting('rawr.app_password', true);
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rawr_app') THEN
    IF pw IS NULL OR pw = '' THEN
      CREATE ROLE rawr_app NOLOGIN;
      RAISE NOTICE 'rawr_app created without a password. Set APP_DB_PASSWORD and migrate again, or ALTER ROLE by hand.';
    ELSE
      EXECUTE format('CREATE ROLE rawr_app LOGIN PASSWORD %L', pw);
    END IF;
  ELSIF pw IS NOT NULL AND pw <> '' THEN
    EXECUTE format('ALTER ROLE rawr_app LOGIN PASSWORD %L', pw);
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO rawr_app;

-- The queue's own tables, read only. /settings/jobs shows failed jobs, and with
-- nothing else to go on "no failed jobs" and "the worker has been dead since
-- Tuesday" render identically. The one fact that separates them is when the
-- dispatcher last finished anything, and it lives in pg-boss's schema.
--
-- Conditional because pg-boss creates its own schema on the worker's first boot,
-- which on a fresh database is after this runs. Bootstrap runs on every migrate,
-- so the grant lands on the next one. Read only, and on job_common alone: the
-- app never enqueues or completes through this role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN
    GRANT USAGE ON SCHEMA pgboss TO rawr_app;
    IF EXISTS (
      SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'pgboss' AND c.relname = 'job_common'
    ) THEN
      GRANT SELECT ON pgboss.job_common TO rawr_app;
    END IF;
  END IF;
END $$;
