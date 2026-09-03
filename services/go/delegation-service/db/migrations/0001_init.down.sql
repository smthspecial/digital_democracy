-- Reverses 0001_init.up.sql for delegation-service (SRV-010).
-- Order: table (drops its policies/indexes/constraints with it) -> shared
-- helper function -> roles. No enum types or append-only triggers exist for
-- this service's single table (TBL-023 delegation), so those steps are
-- omitted.

-- 1. Table (policies, indexes, and CHECK constraints are dropped along with it)
DROP TABLE IF EXISTS delegation;

-- 2. Session-context helper (safe to drop only after the table/policies that
--    reference it are gone)
DROP FUNCTION IF EXISTS current_citizen_id();

-- 3. Roles
-- DROP OWNED BY clears any remaining privileges/default-privileges held by
-- these roles (e.g. the schema USAGE grant) so DROP ROLE below succeeds even
-- if this database has other objects the roles were touched by.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'delegation_app') THEN
    EXECUTE 'DROP OWNED BY delegation_app';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'delegation_worker') THEN
    EXECUTE 'DROP OWNED BY delegation_worker';
  END IF;
END
$$;

DROP ROLE IF EXISTS delegation_app;
DROP ROLE IF EXISTS delegation_worker;

-- Schema-level REVOKE ALL ... FROM PUBLIC from the up migration is intentionally
-- not reversed: leaving the public schema locked down to PUBLIC is safe, and no
-- other principal in this dedicated database needs it restored.

-- 4. Extension (safe to drop now that the table using gen_random_uuid() is gone)
DROP EXTENSION IF EXISTS pgcrypto;
