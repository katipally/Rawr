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
