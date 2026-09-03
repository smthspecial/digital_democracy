-- SRV-001 identity-service — reverts 0001_init.up.sql.
-- Drops in dependency order: (no append-only triggers/functions on this service's
-- tables), tables, types, helper function, roles.

-- ============================================================================
-- 1. Tables (policies/grants are dropped implicitly with their table)
-- ============================================================================

DROP TABLE IF EXISTS identity_verification;
DROP TABLE IF EXISTS citizen;

-- ============================================================================
-- 2. Enum types
-- ============================================================================

DROP TYPE IF EXISTS identity_verification_status;
DROP TYPE IF EXISTS identity_verification_method;
DROP TYPE IF EXISTS citizen_status;
DROP TYPE IF EXISTS citizen_citizenship_status;

-- ============================================================================
-- 3. Session context helper
-- ============================================================================

DROP FUNCTION IF EXISTS current_citizen_id();

-- ============================================================================
-- 4. Schema privileges and roles
-- ============================================================================

REVOKE ALL ON SCHEMA public FROM identity_app;
REVOKE ALL ON SCHEMA public FROM identity_worker;

DROP ROLE IF EXISTS identity_app;
DROP ROLE IF EXISTS identity_worker;
