-- civic-duty-service (SRV-009) — reverse 0001_init.up.sql
-- Drops in dependency order: tables (incl. their policies/triggers) -> types
-- -> shared helper function -> role grants -> roles -> schema-level grant.

-- ============================================================================
-- 1. Tables (policies, RLS settings, and grants on them drop automatically)
-- ============================================================================

DROP TABLE IF EXISTS participation_record;
DROP TABLE IF EXISTS civic_assignment;

-- ============================================================================
-- 2. Enum types (must come after the tables that use them)
-- ============================================================================

DROP TYPE IF EXISTS participation_exemption_status;
DROP TYPE IF EXISTS civic_assignment_status;
DROP TYPE IF EXISTS civic_assignment_type;

-- ============================================================================
-- 3. Shared session-context helper
-- ============================================================================

DROP FUNCTION IF EXISTS current_citizen_id();

-- ============================================================================
-- 4. Roles
-- ============================================================================
-- DROP OWNED BY revokes any remaining grants/privileges held by each role
-- (e.g. the schema USAGE grant below) so DROP ROLE doesn't fail with
-- "role cannot be dropped because some objects depend on it".

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'civic_duty_app') THEN
    DROP OWNED BY civic_duty_app;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'civic_duty_worker') THEN
    DROP OWNED BY civic_duty_worker;
  END IF;
END
$$;

DROP ROLE IF EXISTS civic_duty_app;
DROP ROLE IF EXISTS civic_duty_worker;

-- ============================================================================
-- 5. Schema-level grant (reverses the up migration's REVOKE ALL FROM PUBLIC)
-- ============================================================================

GRANT ALL ON SCHEMA public TO PUBLIC;
