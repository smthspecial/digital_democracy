-- Reverses 0001_init.up.sql for SRV-005 competency-service, in dependency order:
-- tables (children before parents) -> function -> enum types -> roles.
-- This service defines no append-only tables, so no forbid-mutation
-- triggers/functions need dropping here.

DROP TABLE IF EXISTS expert_assessment;
DROP TABLE IF EXISTS conflict_of_interest;
DROP TABLE IF EXISTS competency_challenge;
DROP TABLE IF EXISTS competency;
DROP TABLE IF EXISTS expert_domain;

DROP FUNCTION IF EXISTS current_citizen_id();

DROP TYPE IF EXISTS conflict_of_interest_type;
DROP TYPE IF EXISTS competency_challenge_status;
DROP TYPE IF EXISTS competency_challenge_reason;
DROP TYPE IF EXISTS competency_status;

-- Drop all objects/privileges owned by or granted to these roles before
-- dropping the roles themselves (DROP ROLE fails while grants remain).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'competency_app') THEN
    EXECUTE 'DROP OWNED BY competency_app';
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'competency_worker') THEN
    EXECUTE 'DROP OWNED BY competency_worker';
  END IF;
END
$$;

DROP ROLE IF EXISTS competency_app;
DROP ROLE IF EXISTS competency_worker;
