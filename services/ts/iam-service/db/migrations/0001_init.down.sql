-- SRV-018 iam-service — reverts 0001_init.up.sql, dependency order.
-- Policies/grants are dropped implicitly with their owning table.

-- ---------------------------------------------------------------------------
-- 1. Tables (child before parent: policy_attachment FKs to access_policy;
--    policy_endorsement has no real FK to either, so its drop order relative
--    to them doesn't matter)
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS policy_endorsement CASCADE;
DROP TABLE IF EXISTS policy_attachment CASCADE;
DROP TABLE IF EXISTS access_policy CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Enum types
-- ---------------------------------------------------------------------------

DROP TYPE IF EXISTS policy_endorsement_decision;
DROP TYPE IF EXISTS policy_endorsement_target_type;
DROP TYPE IF EXISTS policy_attachment_status;
DROP TYPE IF EXISTS access_policy_status;
DROP TYPE IF EXISTS access_policy_effect;

-- ---------------------------------------------------------------------------
-- 3. Session-context helper
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS current_citizen_id();

-- ---------------------------------------------------------------------------
-- 4. Schema privileges and roles
-- ---------------------------------------------------------------------------

REVOKE ALL ON SCHEMA public FROM iam_app;
REVOKE ALL ON SCHEMA public FROM iam_worker;

DROP ROLE IF EXISTS iam_app;
DROP ROLE IF EXISTS iam_worker;

-- Deliberately not restored: `GRANT ALL ON SCHEMA public TO PUBLIC` (the up
-- migration's REVOKE was a deliberate hardening, not an incidental side
-- effect to undo — matches governance-role-service/auth-service's down
-- migrations).

-- ---------------------------------------------------------------------------
-- 5. Extension
-- ---------------------------------------------------------------------------

DROP EXTENSION IF EXISTS pgcrypto;
