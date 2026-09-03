-- SRV-001 identity-service — initial schema, roles, and RLS policies.
-- Implements ADR-024 / ARCH-023 for this service's own dedicated Postgres database.
-- Owned tables (per srv-001.md): TBL-001 citizen, TBL-002 identity_verification.

-- ============================================================================
-- 0. Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- ============================================================================
-- 1. Roles (ARCH-023 §2) — idempotent
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'identity_app') THEN
    CREATE ROLE identity_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'identity_worker') THEN
    CREATE ROLE identity_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO identity_app, identity_worker;

-- ============================================================================
-- 2. Session context helper (ARCH-023 §3)
-- ============================================================================

CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;

-- app.actor_role is set alongside app.citizen_id by the application (ARCH-023 §3);
-- no policy in this pass keys off it yet, but the GUC contract is established here
-- so a future policy addition doesn't require touching the session-setup code path.

-- ============================================================================
-- 3. Enum types
-- ============================================================================

-- TBL-001 citizen.citizenship_status
CREATE TYPE citizen_citizenship_status AS ENUM ('citizen', 'revoked', 'suspended');

-- TBL-001 citizen.status
-- NOTE: tbl-001.md documents only {active, inactive, revoked} for this column. ARCH-010/ARCH-021
-- (identity-service's actual in-memory prototype) instead model a single status field with
-- {pending, active, suspended, revoked}. Per this migration's brief — match tbl-NNN.md exactly —
-- the enum below reflects the documented spec, not the current in-memory prototype's values;
-- flagged here so a future reconciliation pass doesn't have to re-discover the discrepancy.
CREATE TYPE citizen_status AS ENUM ('active', 'inactive', 'revoked');

-- TBL-002 identity_verification.method
CREATE TYPE identity_verification_method AS ENUM ('national_id', 'passport', 'gov_credential');

-- TBL-002 identity_verification.status
CREATE TYPE identity_verification_status AS ENUM ('verified', 'rejected');

-- ============================================================================
-- 4. Tables
-- ============================================================================

-- TBL-001 citizen — core civic identity (FR-001, FR-002). Government identifiers, address,
-- and voting history are NEVER stored or exposed here (NFR-006). No relations in this table's
-- own front matter; identity_verification (TBL-002) below is the only table referencing it.
CREATE TABLE citizen (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Judgment call: deliberately NOT UNIQUE. ARCH-010 (HP-6) and ARCH-021 confirm the real
  -- behavior this mirrors: two citizens with public_handles differing only by case/whitespace
  -- (e.g. "alice" / " Alice ") both register successfully (201/201) — duplicate/near-duplicate
  -- handles are left to DP-024's async fuzzy signal scan, not blocked synchronously at write time.
  public_handle       text NOT NULL,
  citizenship_status  citizen_citizenship_status NOT NULL,
  -- Judgment call: UNIQUE enforces SRV-001's "one-person-one-identity invariant" (srv-001.md Key
  -- rules) at the DB level. ARCH-010's HP-5/EC-19 confirm the real behavior this mirrors: an
  -- identical legal_identity_hash is rejected synchronously (409 "identity already exists for
  -- this legal identifier") at registration, and the constraint is never lifted even for a later
  -- revoked/suspended citizen (EC-19: the hash stays reserved forever). DP-024/DP-056's async
  -- duplicate sweep is a separate, fuzzy (handle-signal-based) detector for non-identical-hash
  -- cases this exact constraint can't catch (ARCH-010 HP-6).
  legal_identity_hash text NOT NULL,
  status              citizen_status NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT citizen_legal_identity_hash_key UNIQUE (legal_identity_hash)
);

-- TBL-002 identity_verification — verification attempts and outcomes (FR-002, FR-005).
-- relations: citizen_id -> TBL-001 citizen (this service — real FK, ON DELETE RESTRICT)
CREATE TABLE identity_verification (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id    uuid NOT NULL REFERENCES citizen(id) ON DELETE RESTRICT,
  method        identity_verification_method NOT NULL,
  evidence_ref  text NOT NULL, -- encrypted reference to verification evidence; never public (Notes)
  -- Kept NOT NULL (doc does not call this column nullable). tbl-002.md's Notes state "a
  -- verification record is only ever created already-decided" (DP-002 supplies the outcome
  -- synchronously) — read here as "when this record's outcome was decided," populated for both
  -- verified and rejected rows, rather than introducing a nullability the doc doesn't document.
  verified_at   timestamptz NOT NULL,
  status        identity_verification_status NOT NULL
);

-- ============================================================================
-- 5. Row-level security
-- ============================================================================

ALTER TABLE citizen ENABLE ROW LEVEL SECURITY;
ALTER TABLE citizen FORCE ROW LEVEL SECURITY;

ALTER TABLE identity_verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_verification FORCE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 5a. citizen — ARCH-023 §6: OWN, keyed on id = current_citizen_id() (this table
--     IS the citizen row, so the "owning column" is its own primary key, not a
--     citizen_id foreign column). INSERT is unconditional per §6's explicit note:
--     "_app INSERT unconditional (self-registration, DP-001, unauthenticated)" —
--     there is no current_citizen_id() to check against yet at registration time.
-- ----------------------------------------------------------------------------

CREATE POLICY citizen_own_select ON citizen
  FOR SELECT TO identity_app
  USING (id = current_citizen_id());

CREATE POLICY citizen_self_register_insert ON citizen
  FOR INSERT TO identity_app
  WITH CHECK (true);

CREATE POLICY citizen_own_update ON citizen
  FOR UPDATE TO identity_app
  USING (id = current_citizen_id()) WITH CHECK (id = current_citizen_id());

CREATE POLICY citizen_worker_all ON citizen
  FOR ALL TO identity_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON citizen TO identity_app;
GRANT SELECT, INSERT, UPDATE ON citizen TO identity_worker; -- never DELETE (ARCH-023 §2)

-- ----------------------------------------------------------------------------
-- 5b. identity_verification — ARCH-023 §6: OWN, keyed on citizen_id. Standard
--     select/insert/update-by-owner template; the classification table does not
--     except this table from the update policy the way it does e.g. ballot.
-- ----------------------------------------------------------------------------

CREATE POLICY identity_verification_own_select ON identity_verification
  FOR SELECT TO identity_app
  USING (citizen_id = current_citizen_id());

CREATE POLICY identity_verification_own_insert ON identity_verification
  FOR INSERT TO identity_app
  WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY identity_verification_own_update ON identity_verification
  FOR UPDATE TO identity_app
  USING (citizen_id = current_citizen_id()) WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY identity_verification_worker_all ON identity_verification
  FOR ALL TO identity_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON identity_verification TO identity_app;
GRANT SELECT, INSERT, UPDATE ON identity_verification TO identity_worker; -- never DELETE (ARCH-023 §2)
