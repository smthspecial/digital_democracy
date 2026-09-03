-- SRV-014 reputation-service — reverse of 0001_init.up.sql, in dependency order.

-- ============================================================================
-- 1. Tables (drops their policies, indexes, and constraints along with them)
-- ============================================================================
DROP TABLE IF EXISTS reputation_record CASCADE;

-- ============================================================================
-- 2. Helper function
-- ============================================================================
DROP FUNCTION IF EXISTS current_citizen_id();

-- ============================================================================
-- 3. Enum types
-- ============================================================================
DROP TYPE IF EXISTS reputation_record_factor_type;

-- ============================================================================
-- 4. Roles — strip any remaining ownership/grants, then drop
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'reputation_app') THEN
    EXECUTE 'DROP OWNED BY reputation_app';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'reputation_worker') THEN
    EXECUTE 'DROP OWNED BY reputation_worker';
  END IF;
END
$$;

DROP ROLE IF EXISTS reputation_app;
DROP ROLE IF EXISTS reputation_worker;

-- Restore the default public-schema grant this migration revoked.
GRANT ALL ON SCHEMA public TO PUBLIC;

-- ============================================================================
-- 5. Extension
-- ============================================================================
DROP EXTENSION IF EXISTS pgcrypto;
