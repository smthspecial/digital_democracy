-- SRV-004 proposal-service — reverts 0001_init.up.sql.
-- Drops in dependency order: (no append-only triggers/functions on this service's
-- tables), tables, types, helper function, roles.

-- ============================================================================
-- 1. Tables (policies/grants are dropped implicitly with their table)
-- ============================================================================

DROP TABLE IF EXISTS proposal_budget;
DROP TABLE IF EXISTS proposal_constraint;
DROP TABLE IF EXISTS proposal;

-- ============================================================================
-- 2. Enum types
-- ============================================================================

DROP TYPE IF EXISTS proposal_status;

-- ============================================================================
-- 3. Session context helper
-- ============================================================================

DROP FUNCTION IF EXISTS current_citizen_id();

-- ============================================================================
-- 4. Schema privileges and roles
-- ============================================================================

REVOKE ALL ON SCHEMA public FROM proposal_app;
REVOKE ALL ON SCHEMA public FROM proposal_worker;

DROP ROLE IF EXISTS proposal_app;
DROP ROLE IF EXISTS proposal_worker;
