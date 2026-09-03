-- 0001_init.down.sql — audit-service (SRV-012)
-- Reverses 0001_init.up.sql in dependency order: triggers/trigger-functions,
-- tables (FK-dependent first), enum types, the session helper, roles.

-- ---------------------------------------------------------------------------
-- 1. Triggers and trigger functions (audit_log append-only + hash chain)
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS audit_log_hash_chain ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;

DROP FUNCTION IF EXISTS audit_log_check_hash_chain();
DROP FUNCTION IF EXISTS audit_log_forbid_mutation();

-- ---------------------------------------------------------------------------
-- 2. Tables (FK-dependent table first: constitutional_review references
--    constitutional_right)
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS constitutional_review CASCADE;
DROP TABLE IF EXISTS constitutional_right CASCADE;
DROP TABLE IF EXISTS audit_log CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Enum types
-- ---------------------------------------------------------------------------

DROP TYPE IF EXISTS constitutional_review_result;
DROP TYPE IF EXISTS audit_log_action_type;

-- ---------------------------------------------------------------------------
-- 4. Session context helper
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS current_citizen_id();

-- ---------------------------------------------------------------------------
-- 5. Roles
-- ---------------------------------------------------------------------------
-- DROP OWNED BY clears each role's remaining schema-level grants (e.g.
-- USAGE ON SCHEMA public) so DROP ROLE below doesn't fail with
-- "role cannot be dropped because some objects depend on it". Per-table
-- grants/policies are already gone with the tables dropped above.
--
-- Note: this does not restore PUBLIC's original default privileges on
-- schema public (REVOKE ALL ... FROM PUBLIC in the up migration) — that
-- default varies by Postgres version/config, and this database exists only
-- for these two roles, so restoring it is intentionally left undone.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_app') THEN
    EXECUTE 'DROP OWNED BY audit_app';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_worker') THEN
    EXECUTE 'DROP OWNED BY audit_worker';
  END IF;
END
$$;

DROP ROLE IF EXISTS audit_app;
DROP ROLE IF EXISTS audit_worker;

-- ---------------------------------------------------------------------------
-- 6. Extension
-- ---------------------------------------------------------------------------

DROP EXTENSION IF EXISTS pgcrypto;
