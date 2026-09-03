-- governance-role-service (SRV-011) — revert initial schema
--
-- Drops everything 0001_init.up.sql created, in dependency order. Policies/triggers are dropped
-- implicitly with their owning tables; grants are dropped implicitly when the granted-on objects
-- are dropped.

-- ---------------------------------------------------------------------------
-- 1. Tables (child before parent: approval FKs to governance_role)
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS approval CASCADE;
DROP TABLE IF EXISTS governance_role CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Session-context helper
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS current_citizen_id();

-- ---------------------------------------------------------------------------
-- 3. Enum types
-- ---------------------------------------------------------------------------

DROP TYPE IF EXISTS decision_enum;
DROP TYPE IF EXISTS approval_type_enum;
DROP TYPE IF EXISTS layer_enum;
DROP TYPE IF EXISTS role_type_enum;

-- ---------------------------------------------------------------------------
-- 4. Roles
-- ---------------------------------------------------------------------------

-- Schema-level privileges must be revoked before DROP ROLE will succeed (table-level grants were
-- already removed by the DROP TABLE statements above).
REVOKE ALL ON SCHEMA public FROM governance_role_app;
REVOKE ALL ON SCHEMA public FROM governance_role_worker;

DROP ROLE IF EXISTS governance_role_app;
DROP ROLE IF EXISTS governance_role_worker;

-- Deliberately not restored: `GRANT ALL ON SCHEMA public TO PUBLIC` (the up migration's REVOKE was
-- a deliberate hardening, not an incidental side effect to undo).

-- ---------------------------------------------------------------------------
-- 5. Extension
-- ---------------------------------------------------------------------------

DROP EXTENSION IF EXISTS pgcrypto;
