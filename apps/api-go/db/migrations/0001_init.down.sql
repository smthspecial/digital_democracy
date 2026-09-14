-- Down drops in dependency order: triggers, then tables (policies drop
-- with their tables), then functions, then roles.
DROP TRIGGER IF EXISTS audit_log_chain ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
DROP TRIGGER IF EXISTS ballot_no_update ON ballot;
DROP TRIGGER IF EXISTS ballot_no_delete ON ballot;
DROP TABLE IF EXISTS auth_event;
DROP TABLE IF EXISTS mfa_factor;
DROP TABLE IF EXISTS session;
DROP TABLE IF EXISTS protocol_change;
DROP TABLE IF EXISTS constitutional_review;
DROP TABLE IF EXISTS constitutional_right;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS delegation;
DROP TABLE IF EXISTS ballot;
DROP TABLE IF EXISTS eligibility_token;
DROP TABLE IF EXISTS vote_option;
DROP TABLE IF EXISTS vote_session;
DROP FUNCTION IF EXISTS audit_log_enforce_chain();
DROP FUNCTION IF EXISTS audit_log_forbid_mutation();
DROP FUNCTION IF EXISTS ballot_forbid_mutation();
DROP FUNCTION IF EXISTS current_citizen_id();
DROP ROLE IF EXISTS api_worker;
DROP ROLE IF EXISTS api_app;
