-- SRV-017 auth-service — reverts 0001_init.up.sql.
-- Drops in dependency order: append-only triggers/function (auth_event),
-- tables (FK-dependent first), enum types, session-context helper, schema
-- privileges, roles.

-- ---------------------------------------------------------------------------
-- 1. Append-only enforcement (auth_event)
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS auth_event_no_delete ON auth_event;
DROP TRIGGER IF EXISTS auth_event_no_update ON auth_event;
DROP FUNCTION IF EXISTS auth_event_forbid_mutation();

-- ---------------------------------------------------------------------------
-- 2. Tables (policies/grants are dropped implicitly with their table;
--    auth_event first — it FK-references session)
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS auth_event;
DROP TABLE IF EXISTS mfa_factor;
DROP TABLE IF EXISTS session;

-- ---------------------------------------------------------------------------
-- 3. Enum types
-- ---------------------------------------------------------------------------

DROP TYPE IF EXISTS auth_event_type;
DROP TYPE IF EXISTS mfa_factor_status;
DROP TYPE IF EXISTS mfa_factor_type;
DROP TYPE IF EXISTS session_status;
DROP TYPE IF EXISTS session_assurance_tier;

-- ---------------------------------------------------------------------------
-- 4. Session context helper
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS current_citizen_id();

-- ---------------------------------------------------------------------------
-- 5. Schema privileges and roles
-- ---------------------------------------------------------------------------

REVOKE ALL ON SCHEMA public FROM auth_app;
REVOKE ALL ON SCHEMA public FROM auth_worker;

DROP ROLE IF EXISTS auth_app;
DROP ROLE IF EXISTS auth_worker;
