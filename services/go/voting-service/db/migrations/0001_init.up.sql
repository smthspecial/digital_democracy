-- SRV-008 voting-service — initial schema, roles, and row-level security.
-- Implements ARCH-023 (RLS + DB-level consistency pattern) / ADR-024 for this service's own database.
-- Owned tables (per srv-008.md): TBL-019 vote_session, TBL-020 vote_option,
-- TBL-021 eligibility_token, TBL-022 ballot.

-- ============================================================================
-- 0. Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ============================================================================
-- 1. Roles (ARCH-023 §2) — idempotent, since roles are cluster-wide objects.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'voting_app') THEN
    CREATE ROLE voting_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'voting_worker') THEN
    CREATE ROLE voting_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;
-- Login credentials for these roles are provisioned out-of-band at deploy time
-- (secrets manager / ALTER ROLE ... PASSWORD), never committed to migration SQL.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO voting_app, voting_worker;

-- ============================================================================
-- 2. Session context helper (ARCH-023 §3)
-- ============================================================================

CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;

-- ============================================================================
-- 3. Enum types (from each tbl-NNN.md's documented enum columns)
-- ============================================================================

CREATE TYPE vote_method AS ENUM ('ranked_choice', 'approval', 'preference_score', 'comparative'); -- TBL-019.method
CREATE TYPE vote_threshold_rule AS ENUM ('simple_majority', 'majority_plus_quorum', 'supermajority'); -- TBL-019.threshold_rule
CREATE TYPE vote_session_status AS ENUM ('scheduled', 'open', 'closed', 'certified'); -- TBL-019.status

-- ============================================================================
-- 4. TBL-019 vote_session
-- Class: PUBLIC (ARCH-023 §6) — read any; write _worker only (DP-025/DP-027).
-- ============================================================================

CREATE TABLE vote_session (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id        uuid NOT NULL, -- cross-service ref: proposal-service.proposal(id); no FK (ADR-015 §5 boundary)
  jurisdiction_id    uuid NOT NULL, -- cross-service ref: jurisdiction-service.jurisdiction(id); no FK (ADR-015 §5 boundary)
  method             vote_method NOT NULL,
  threshold_rule     vote_threshold_rule NOT NULL,
  min_participation  numeric NOT NULL CHECK (min_participation >= 0), -- judgment call: quorum fraction/count cannot be negative
  cooling_off_until  timestamptz NOT NULL,
  opens_at           timestamptz NOT NULL,
  closes_at          timestamptz NOT NULL,
  status             vote_session_status NOT NULL DEFAULT 'scheduled',
  CHECK (closes_at > opens_at), -- judgment call: voting window must be non-empty and ordered
  CHECK (opens_at >= cooling_off_until) -- judgment call: voting cannot open before cooling-off ends (DP-057)
);

ALTER TABLE vote_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE vote_session FORCE ROW LEVEL SECURITY;

CREATE POLICY vote_session_public_read ON vote_session FOR SELECT TO voting_app, voting_worker
  USING (true);
CREATE POLICY vote_session_worker_all ON vote_session FOR ALL TO voting_worker
  USING (true) WITH CHECK (true);

GRANT SELECT ON vote_session TO voting_app;
GRANT SELECT, INSERT, UPDATE ON vote_session TO voting_worker;

-- ============================================================================
-- 5. TBL-020 vote_option
-- Class: PUBLIC (ARCH-023 §6) — read any; write _worker only.
-- ============================================================================

CREATE TABLE vote_option (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_session_id  uuid NOT NULL REFERENCES vote_session(id) ON DELETE RESTRICT,
  proposal_id      uuid NOT NULL, -- cross-service ref: proposal-service.proposal(id); no FK (ADR-015 §5 boundary)
  label            text NOT NULL,
  description      text NOT NULL
);

ALTER TABLE vote_option ENABLE ROW LEVEL SECURITY;
ALTER TABLE vote_option FORCE ROW LEVEL SECURITY;

CREATE POLICY vote_option_public_read ON vote_option FOR SELECT TO voting_app, voting_worker
  USING (true);
CREATE POLICY vote_option_worker_all ON vote_option FOR ALL TO voting_worker
  USING (true) WITH CHECK (true);

GRANT SELECT ON vote_option TO voting_app;
GRANT SELECT, INSERT, UPDATE ON vote_option TO voting_worker;

-- ============================================================================
-- 6. TBL-021 eligibility_token
-- Class: SPECIAL (ARCH-023 §4.5) — OWN read only (citizen may confirm holding
-- a token and its `used` state); NO OWN write policy at all — only
-- voting_worker may INSERT (DP-025 batch-issue) or UPDATE `used` (DP-016).
-- ============================================================================

CREATE TABLE eligibility_token (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_session_id    uuid NOT NULL REFERENCES vote_session(id) ON DELETE RESTRICT,
  citizen_id         uuid NOT NULL, -- cross-service ref: identity-service.citizen(id); no FK (ADR-015 §5 boundary)
  blinded_token_hash text NOT NULL,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  used               boolean NOT NULL DEFAULT false,
  UNIQUE (vote_session_id, citizen_id) -- srv-008.md: "makes it idempotent" — one token per citizen per session
);

ALTER TABLE eligibility_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE eligibility_token FORCE ROW LEVEL SECURITY;

CREATE POLICY eligibility_token_own_select ON eligibility_token FOR SELECT TO voting_app
  USING (citizen_id = current_citizen_id());
-- Deliberately no voting_app INSERT/UPDATE policy (ARCH-023 §4.5): only the
-- worker may issue tokens or flip `used`, inside the single DP-016 transaction.
CREATE POLICY eligibility_token_worker_all ON eligibility_token FOR ALL TO voting_worker
  USING (true) WITH CHECK (true);

GRANT SELECT ON eligibility_token TO voting_app;
GRANT SELECT, INSERT, UPDATE ON eligibility_token TO voting_worker;

-- ============================================================================
-- 7. TBL-022 ballot
-- Class: SPECIAL (ARCH-023 §4.5) + APPEND_ONLY (§4.4).
-- No citizen_id column, ever, and no policy here may join back to
-- eligibility_token/citizen (TBL-022 notes; ADR-002/NFR-001 ballot secrecy).
-- PUBLIC read (verifiable voting, unauthenticated ballot:verify); worker-only
-- insert; never updated or deleted once cast.
-- ============================================================================

CREATE TABLE ballot (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_session_id    uuid NOT NULL REFERENCES vote_session(id) ON DELETE RESTRICT,
  token_blind        text NOT NULL,
  encrypted_choice   text NOT NULL,
  verification_code  text NOT NULL UNIQUE, -- judgment call: DP-017 (verify ballot inclusion) looks a ballot up by this code, so it must be unique
  cast_at            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ballot ENABLE ROW LEVEL SECURITY;
ALTER TABLE ballot FORCE ROW LEVEL SECURITY;

CREATE POLICY ballot_public_read ON ballot FOR SELECT TO voting_app, voting_worker
  USING (true);
CREATE POLICY ballot_worker_all ON ballot FOR ALL TO voting_worker
  USING (true) WITH CHECK (true);

GRANT SELECT ON ballot TO voting_app;
GRANT SELECT, INSERT, UPDATE ON ballot TO voting_worker;

-- APPEND_ONLY enforcement (ARCH-023 §4.4): a cast ballot is never edited or removed.
REVOKE UPDATE, DELETE ON ballot FROM voting_app, voting_worker;

CREATE OR REPLACE FUNCTION ballot_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ballot is append-only: % not permitted', TG_OP;
END;
$$;
CREATE TRIGGER ballot_no_update BEFORE UPDATE ON ballot
  FOR EACH ROW EXECUTE FUNCTION ballot_forbid_mutation();
CREATE TRIGGER ballot_no_delete BEFORE DELETE ON ballot
  FOR EACH ROW EXECUTE FUNCTION ballot_forbid_mutation();
