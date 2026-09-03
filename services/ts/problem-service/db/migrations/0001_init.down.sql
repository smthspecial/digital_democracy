-- Reverses 0001_init.up.sql for SRV-003 problem-service, in dependency order.
-- Table drops cascade their own policies, grants, and RLS settings, so those
-- do not need separate statements.

-- ---------------------------------------------------------------------------
-- 1. Tables (child before parent: problem_support references problem)
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS problem_support CASCADE;
DROP TABLE IF EXISTS problem CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Enum types
-- ---------------------------------------------------------------------------

DROP TYPE IF EXISTS problem_status;

-- ---------------------------------------------------------------------------
-- 3. Session-context helper
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS current_citizen_id();

-- ---------------------------------------------------------------------------
-- 4. Roles — drop anything still owned by them first so DROP ROLE doesn't
--    fail on leftover schema-level grants (e.g. the USAGE ON SCHEMA public
--    granted in the up migration), then drop the roles themselves.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'problem_app') THEN
    EXECUTE 'DROP OWNED BY problem_app';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'problem_worker') THEN
    EXECUTE 'DROP OWNED BY problem_worker';
  END IF;
END
$$;

DROP ROLE IF EXISTS problem_app;
DROP ROLE IF EXISTS problem_worker;

-- Restore the default schema grant this migration's up side revoked.
GRANT ALL ON SCHEMA public TO PUBLIC;

-- ---------------------------------------------------------------------------
-- 5. Extension
-- ---------------------------------------------------------------------------

DROP EXTENSION IF EXISTS pgcrypto;
