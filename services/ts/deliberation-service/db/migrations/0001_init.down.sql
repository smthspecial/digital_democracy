-- SRV-006 deliberation-service — reverts 0001_init.up.sql.
-- Drops in dependency order: (no append-only triggers/functions on this service's
-- tables), tables, types, helper function, roles.

-- ============================================================================
-- 1. Tables (policies/grants are dropped implicitly with their table)
-- ============================================================================

DROP TABLE IF EXISTS preference;
DROP TABLE IF EXISTS deliberation_argument;

-- ============================================================================
-- 2. Enum types
-- ============================================================================

DROP TYPE IF EXISTS deliberation_argument_stance;

-- ============================================================================
-- 3. Session context helper
-- ============================================================================

DROP FUNCTION IF EXISTS current_citizen_id();

-- ============================================================================
-- 4. Schema privileges and roles
-- ============================================================================

REVOKE ALL ON SCHEMA public FROM deliberation_app;
REVOKE ALL ON SCHEMA public FROM deliberation_worker;

DROP ROLE IF EXISTS deliberation_app;
DROP ROLE IF EXISTS deliberation_worker;
