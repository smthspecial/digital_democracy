-- SRV-008 voting-service — reverse of 0001_init.up.sql, in dependency order.

-- 1. Append-only trigger + function (ballot)
DROP TRIGGER IF EXISTS ballot_no_delete ON ballot;
DROP TRIGGER IF EXISTS ballot_no_update ON ballot;
DROP FUNCTION IF EXISTS ballot_forbid_mutation();

-- 2. Tables (children of vote_session first; policies/grants drop with the table)
DROP TABLE IF EXISTS ballot;
DROP TABLE IF EXISTS eligibility_token;
DROP TABLE IF EXISTS vote_option;
DROP TABLE IF EXISTS vote_session;

-- 3. Enum types
DROP TYPE IF EXISTS vote_session_status;
DROP TYPE IF EXISTS vote_threshold_rule;
DROP TYPE IF EXISTS vote_method;

-- 4. Session context helper
DROP FUNCTION IF EXISTS current_citizen_id();

-- 5. Schema-level grants and roles
REVOKE ALL ON SCHEMA public FROM voting_app;
REVOKE ALL ON SCHEMA public FROM voting_worker;
GRANT ALL ON SCHEMA public TO PUBLIC;

DROP ROLE IF EXISTS voting_app;
DROP ROLE IF EXISTS voting_worker;
