-- jurisdiction-service (SRV-002) — reverse of 0001_init.up.sql, in dependency order.

-- ============================================================================
-- 1. Tables (drops their policies, indexes, and constraints along with them)
-- ============================================================================
-- Drop children before the parent they FK to; CASCADE as a safety net for
-- anything not explicitly ordered above.
DROP TABLE IF EXISTS jurisdiction_membership CASCADE;
DROP TABLE IF EXISTS residency CASCADE;
DROP TABLE IF EXISTS jurisdiction CASCADE;

-- ============================================================================
-- 2. Helper function
-- ============================================================================
DROP FUNCTION IF EXISTS current_citizen_id();

-- ============================================================================
-- 3. Enum types
-- ============================================================================
DROP TYPE IF EXISTS residency_status;
DROP TYPE IF EXISTS jurisdiction_status;
DROP TYPE IF EXISTS jurisdiction_scope_level;

-- ============================================================================
-- 4. Roles — strip any remaining ownership/grants, then drop
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'jurisdiction_app') THEN
    EXECUTE 'DROP OWNED BY jurisdiction_app';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'jurisdiction_worker') THEN
    EXECUTE 'DROP OWNED BY jurisdiction_worker';
  END IF;
END
$$;

DROP ROLE IF EXISTS jurisdiction_app;
DROP ROLE IF EXISTS jurisdiction_worker;

-- Restore the default public-schema grant this migration revoked.
GRANT ALL ON SCHEMA public TO PUBLIC;

-- ============================================================================
-- 5. Extension
-- ============================================================================
DROP EXTENSION IF EXISTS pgcrypto;
