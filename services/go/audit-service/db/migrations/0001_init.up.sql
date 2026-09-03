-- 0001_init.up.sql — audit-service (SRV-012)
--
-- Implements ADR-024 / ARCH-023 for this service's own dedicated Postgres
-- database: two roles, RLS forced on every owned table, the shared
-- current_citizen_id() session-GUC helper, and the append-only hash-chain
-- treatment for audit_log (ARCH-023 §4.4).
--
-- Owned tables (SRV-012 / ARCH-023 §6):
--   TBL-034 audit_log             — PUBLIC read + APPEND_ONLY, hash-chained, worker-only insert
--   TBL-035 constitutional_right  — PUBLIC read (registry), worker-only write
--   TBL-036 constitutional_review — PUBLIC read, worker-only write (reviewing role lives in
--                                   governance-role-service — cross-service, ARCH-023 §5)

-- ---------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 2. Roles (ARCH-023 §2) — idempotent
-- ---------------------------------------------------------------------------
-- Passwords are deliberately not set here: they are provisioned out-of-band
-- by whatever deployment/secrets tooling wires this service to Postgres
-- (ADR-024 does not itself connect any service to a real database). Until a
-- password (or another auth method, e.g. cert auth) is set, LOGIN succeeds
-- for neither role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_app') THEN
    CREATE ROLE audit_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'audit_worker') THEN
    CREATE ROLE audit_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Schema privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO audit_app, audit_worker;

-- ---------------------------------------------------------------------------
-- 4. Session context helper (ARCH-023 §3)
-- ---------------------------------------------------------------------------
-- Defined even though no table in this pass carries an OWN-scoped citizen_id
-- column (audit-service's tables are all PUBLIC-read / worker-written per
-- ARCH-023 §6) — kept so a future policy needing it doesn't require touching
-- this migration.

CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- 5. Enum types
-- ---------------------------------------------------------------------------

-- TBL-034 audit_log.action_type
CREATE TYPE audit_log_action_type AS ENUM (
  'proposal_created',
  'proposal_status_changed',
  'vote_certified',
  'system_update',
  'rule_change',
  'admin_action',
  'identity_event'
);

-- TBL-036 constitutional_review.result
CREATE TYPE constitutional_review_result AS ENUM (
  'cleared',
  'blocked'
);

-- ---------------------------------------------------------------------------
-- 6. TBL-034 audit_log
-- ---------------------------------------------------------------------------
-- APPEND_ONLY + hash chain (ARCH-023 §4.4). `seq` is an internal, strictly
-- monotonic ordering column added per ARCH-023 §4.4 — not part of TBL-034's
-- documented business columns; created_at (a timestamp) cannot give a
-- strict, gapless total order under concurrent inserts. UNIQUE on seq backs
-- both the integrity of that ordering and the "last row" lookup the hash
-- chain trigger performs below.

CREATE TABLE audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           bigserial NOT NULL UNIQUE,
  action_type   audit_log_action_type NOT NULL,
  actor_ref     text NOT NULL,
  payload_hash  text NOT NULL,
  prev_hash     text NOT NULL,
  signature     text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

-- PUBLIC read (audit_log:read is T1-public, FR-066 multi-body auditability)
CREATE POLICY audit_log_public_read ON audit_log FOR SELECT TO audit_app, audit_worker
  USING (true);

-- Blanket worker policy (ARCH-023 §4.3) — actual write privilege is still
-- gated by the GRANTs below (no _app INSERT grant exists: writes arrive only
-- via the audit.append queue consumer, DP-036, running as audit_worker) and,
-- for UPDATE/DELETE, by the REVOKE + trigger in section 8.
CREATE POLICY audit_log_worker_all ON audit_log FOR ALL TO audit_worker
  USING (true) WITH CHECK (true);

GRANT SELECT ON audit_log TO audit_app, audit_worker;
GRANT INSERT ON audit_log TO audit_worker;
-- No UPDATE/DELETE grant to either role — see section 8 (APPEND_ONLY).

-- ---------------------------------------------------------------------------
-- 7. TBL-035 constitutional_right
-- ---------------------------------------------------------------------------
-- PUBLIC registry, worker-managed (ARCH-023 §6). No Notes-section invariant
-- calls for a UNIQUE constraint on `name`, so none is added here.

CREATE TABLE constitutional_right (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text NOT NULL,
  protected   boolean NOT NULL
);

ALTER TABLE constitutional_right ENABLE ROW LEVEL SECURITY;
ALTER TABLE constitutional_right FORCE ROW LEVEL SECURITY;

CREATE POLICY constitutional_right_public_read ON constitutional_right FOR SELECT TO audit_app, audit_worker
  USING (true);

CREATE POLICY constitutional_right_worker_all ON constitutional_right FOR ALL TO audit_worker
  USING (true) WITH CHECK (true);

GRANT SELECT ON constitutional_right TO audit_app, audit_worker;
GRANT INSERT, UPDATE ON constitutional_right TO audit_worker;
-- No DELETE grant (ARCH-023 §2: neither role is ever granted DELETE in this pass).

-- ---------------------------------------------------------------------------
-- 8. TBL-036 constitutional_review
-- ---------------------------------------------------------------------------
-- relations: proposal_id -> TBL-008 proposal (proposal-service) — a DIFFERENT
--   service's table. ADR-015 forbids cross-database FKs, so this is
--   intentionally left as an unenforced reference (documented here, not a
--   real FK constraint).
-- relations: right_id -> TBL-035 constitutional_right — owned by THIS same
--   service, so it gets a real FK, ON DELETE RESTRICT (a right definition
--   cannot be removed out from under a review that references it).
--
-- Class: PUBLIC read + worker write (ARCH-023 §6) — the reviewing role for
-- DP-043's approval gate lives in governance-role-service's `governance_role`
-- table, a cross-service check ARCH-023 §5 documents as not locally
-- resolvable; the write itself still happens under audit_worker once the
-- calling code has resolved whatever it needs over HTTP.

CREATE TABLE constitutional_review (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id  uuid NOT NULL, -- cross-service ref: TBL-008 proposal (proposal-service), unenforced per ADR-015
  right_id     uuid NOT NULL REFERENCES constitutional_right(id) ON DELETE RESTRICT,
  result       constitutional_review_result NOT NULL,
  reviewer_ref text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- FK columns are not auto-indexed by Postgres; these back both the FK lookup
-- and the "all reviews for this proposal/right" read pattern DP-034 implies.
CREATE INDEX constitutional_review_proposal_id_idx ON constitutional_review (proposal_id);
CREATE INDEX constitutional_review_right_id_idx ON constitutional_review (right_id);

ALTER TABLE constitutional_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE constitutional_review FORCE ROW LEVEL SECURITY;

CREATE POLICY constitutional_review_public_read ON constitutional_review FOR SELECT TO audit_app, audit_worker
  USING (true);

CREATE POLICY constitutional_review_worker_all ON constitutional_review FOR ALL TO audit_worker
  USING (true) WITH CHECK (true);

GRANT SELECT ON constitutional_review TO audit_app, audit_worker;
GRANT INSERT, UPDATE ON constitutional_review TO audit_worker;
-- No DELETE grant (ARCH-023 §2).

-- ---------------------------------------------------------------------------
-- 9. APPEND_ONLY enforcement for audit_log (ARCH-023 §4.4)
-- ---------------------------------------------------------------------------

REVOKE UPDATE, DELETE ON audit_log FROM audit_app, audit_worker;

CREATE OR REPLACE FUNCTION audit_log_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % not permitted', TG_OP;
END;
$$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_mutation();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_mutation();

-- Hash-chain integrity trigger (ARCH-023 §4.4): every new row's prev_hash
-- must equal the payload_hash of the current last row (by seq), or the
-- fixed genesis sentinel below when the table is empty. The application
-- (DP-036 consumer) must write this same sentinel as prev_hash on the very
-- first row it ever appends.

CREATE OR REPLACE FUNCTION audit_log_check_hash_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_expected_prev_hash text;
BEGIN
  SELECT payload_hash INTO v_expected_prev_hash
    FROM audit_log ORDER BY seq DESC LIMIT 1;

  IF v_expected_prev_hash IS NULL THEN
    -- genesis sentinel: 64 zero hex chars, matching a sha256-shaped hash column
    v_expected_prev_hash := '0000000000000000000000000000000000000000000000000000000000000000';
  END IF;

  IF NEW.prev_hash IS DISTINCT FROM v_expected_prev_hash THEN
    RAISE EXCEPTION 'audit_log hash chain broken: expected prev_hash=%, got %',
      v_expected_prev_hash, NEW.prev_hash;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_log_hash_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_check_hash_chain();
