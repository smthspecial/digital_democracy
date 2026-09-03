-- jurisdiction-service (SRV-002) — initial schema, RLS policies, roles.
-- Implements ARCH-023 (RLS/DB-consistency pattern) per ADR-024, for this service's
-- own dedicated Postgres database only (ADR-015: database-per-service).
--
-- Owned tables (per srv-002.md): TBL-003 jurisdiction, TBL-004 residency,
-- TBL-005 jurisdiction_membership.

-- ============================================================================
-- 0. Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ============================================================================
-- 1. Roles (ARCH-023 §2) — idempotent
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'jurisdiction_app') THEN
    CREATE ROLE jurisdiction_app
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'jurisdiction_worker') THEN
    CREATE ROLE jurisdiction_worker
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- Lock down the default public grant, then re-open only USAGE to our two roles.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO jurisdiction_app, jurisdiction_worker;

-- ============================================================================
-- 2. Session-context helper (ARCH-023 §3)
-- ============================================================================

CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;

-- app.actor_role is reserved for later use (ARCH-023 §3); no policy in this
-- pass keys off it, but the GUC contract is documented here for future authors.

-- ============================================================================
-- 3. Enum types (from each tbl-NNN.md's documented column values)
-- ============================================================================

-- TBL-003 jurisdiction.scope_level
CREATE TYPE jurisdiction_scope_level AS ENUM (
  'property', 'street', 'municipality', 'regional', 'national', 'constitutional'
);

-- TBL-003 jurisdiction.status
CREATE TYPE jurisdiction_status AS ENUM ('active', 'under_review');

-- TBL-004 residency.status
CREATE TYPE residency_status AS ENUM ('active', 'ended');

-- ============================================================================
-- 4. Tables
-- ============================================================================

-- ---------------------------------------------------------------------------
-- TBL-003 jurisdiction — PUBLIC class (ARCH-023 §6): read any, write worker-only.
-- ---------------------------------------------------------------------------
CREATE TABLE jurisdiction (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id    uuid NULL, -- nullable for the national/root jurisdiction
  name         text NOT NULL,
  scope_level  jurisdiction_scope_level NOT NULL,
  boundary_ref text NOT NULL, -- pointer to an external, independently reviewed boundary (ADR-004); never mutable boundary data itself
  status       jurisdiction_status NOT NULL,
  CONSTRAINT jurisdiction_parent_fk
    FOREIGN KEY (parent_id) REFERENCES jurisdiction (id) ON DELETE RESTRICT,
  -- Judgment call: a jurisdiction cannot be its own parent (hierarchy-integrity
  -- invariant implied by "nested jurisdictions" in TBL-003's Notes, not stated
  -- as an explicit constraint).
  CONSTRAINT jurisdiction_parent_not_self CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX jurisdiction_parent_id_idx ON jurisdiction (parent_id);

-- ---------------------------------------------------------------------------
-- TBL-004 residency — OWN class (ARCH-023 §6): citizen_id.
-- ---------------------------------------------------------------------------
CREATE TABLE residency (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id      uuid NOT NULL, -- TBL-001 citizen, owned by identity-service (SRV-001): cross-service reference, intentionally NOT a FK (ADR-015 forbids cross-database FKs)
  jurisdiction_id uuid NOT NULL,
  start_date      date NOT NULL,
  verified        boolean NOT NULL DEFAULT false, -- judgment call: a residency record starts unverified until confirmed; not stated explicitly in TBL-004 but implied by the "verified" flag's purpose
  status          residency_status NOT NULL,
  CONSTRAINT residency_jurisdiction_fk
    FOREIGN KEY (jurisdiction_id) REFERENCES jurisdiction (id) ON DELETE RESTRICT
);

CREATE INDEX residency_citizen_id_idx ON residency (citizen_id);
CREATE INDEX residency_jurisdiction_id_idx ON residency (jurisdiction_id);

-- Judgment call: TBL-004's Notes describe minimum-residency-period checks and
-- explicit "anti residency-manipulation" intent. Read literally that means a
-- citizen must not be able to hold two simultaneously-*active* residency
-- claims in the same jurisdiction (which would let start_date be gamed by
-- re-inserting a fresher row); ended residencies for the same pair remain
-- allowed (a citizen may move away and legitimately return later).
CREATE UNIQUE INDEX residency_one_active_per_citizen_jurisdiction
  ON residency (citizen_id, jurisdiction_id)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- TBL-005 jurisdiction_membership — OWN class (ARCH-023 §6): citizen_id.
-- ---------------------------------------------------------------------------
CREATE TABLE jurisdiction_membership (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id      uuid NOT NULL, -- TBL-001 citizen, owned by identity-service (SRV-001): cross-service reference, intentionally NOT a FK (ADR-015 forbids cross-database FKs)
  jurisdiction_id uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(), -- judgment call: "membership start" (TBL-005 description) defaults to insert time; not stated as a default explicitly
  CONSTRAINT jurisdiction_membership_jurisdiction_fk
    FOREIGN KEY (jurisdiction_id) REFERENCES jurisdiction (id) ON DELETE RESTRICT,
  -- Judgment call: one membership row per citizen per jurisdiction. TBL-005's
  -- Notes explicitly allow *multiple different* simultaneous jurisdictions
  -- per citizen (nested: neighborhood + city + region + national) — this
  -- constraint only forbids a duplicate row for the exact same pair.
  CONSTRAINT jurisdiction_membership_unique_citizen_jurisdiction
    UNIQUE (citizen_id, jurisdiction_id)
);

CREATE INDEX jurisdiction_membership_citizen_id_idx ON jurisdiction_membership (citizen_id);
CREATE INDEX jurisdiction_membership_jurisdiction_id_idx ON jurisdiction_membership (jurisdiction_id);

-- ============================================================================
-- 5. Row-level security (no exceptions, per ARCH-023 §4 preamble)
-- ============================================================================

ALTER TABLE jurisdiction ENABLE ROW LEVEL SECURITY;
ALTER TABLE jurisdiction FORCE ROW LEVEL SECURITY;

ALTER TABLE residency ENABLE ROW LEVEL SECURITY;
ALTER TABLE residency FORCE ROW LEVEL SECURITY;

ALTER TABLE jurisdiction_membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE jurisdiction_membership FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- jurisdiction policies — PUBLIC (ARCH-023 §4.2): read any; write is
-- administrative and goes through jurisdiction_worker only (DP-035 protocol-
-- layer approval, srv-002.md "Key rules"). No jurisdiction_app write policy
-- is defined — the app role can SELECT but has no INSERT/UPDATE grant/policy.
-- ---------------------------------------------------------------------------
CREATE POLICY jurisdiction_public_read ON jurisdiction FOR SELECT
  TO jurisdiction_app, jurisdiction_worker
  USING (true);

CREATE POLICY jurisdiction_worker_all ON jurisdiction FOR ALL
  TO jurisdiction_worker
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- residency policies — OWN (ARCH-023 §4.1).
-- ---------------------------------------------------------------------------
CREATE POLICY residency_own_select ON residency FOR SELECT
  TO jurisdiction_app
  USING (citizen_id = current_citizen_id());

CREATE POLICY residency_own_insert ON residency FOR INSERT
  TO jurisdiction_app
  WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY residency_own_update ON residency FOR UPDATE
  TO jurisdiction_app
  USING (citizen_id = current_citizen_id())
  WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY residency_worker_all ON residency FOR ALL
  TO jurisdiction_worker
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- jurisdiction_membership policies — OWN (ARCH-023 §4.1).
-- ---------------------------------------------------------------------------
CREATE POLICY jurisdiction_membership_own_select ON jurisdiction_membership FOR SELECT
  TO jurisdiction_app
  USING (citizen_id = current_citizen_id());

CREATE POLICY jurisdiction_membership_own_insert ON jurisdiction_membership FOR INSERT
  TO jurisdiction_app
  WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY jurisdiction_membership_own_update ON jurisdiction_membership FOR UPDATE
  TO jurisdiction_app
  USING (citizen_id = current_citizen_id())
  WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY jurisdiction_membership_worker_all ON jurisdiction_membership FOR ALL
  TO jurisdiction_worker
  USING (true) WITH CHECK (true);

-- ============================================================================
-- 6. Grants (SELECT/INSERT/UPDATE only — no DELETE in this pass, ARCH-023 §2)
-- ============================================================================

GRANT SELECT ON jurisdiction TO jurisdiction_app;
GRANT SELECT, INSERT, UPDATE ON jurisdiction TO jurisdiction_worker;

GRANT SELECT, INSERT, UPDATE ON residency TO jurisdiction_app;
GRANT SELECT, INSERT, UPDATE ON residency TO jurisdiction_worker;

GRANT SELECT, INSERT, UPDATE ON jurisdiction_membership TO jurisdiction_app;
GRANT SELECT, INSERT, UPDATE ON jurisdiction_membership TO jurisdiction_worker;

-- ============================================================================
-- Note on cross-service scope limitation (ARCH-023 §5):
--
-- This service is the *source* for AUTH-010's `jurisdiction:member` /
-- `jurisdiction:affected` scope types (residency + jurisdiction_membership
-- live here), but the resources those scopes gate (proposal, problem, ballot
-- eligibility, ...) live in *other* services' databases. No policy in this
-- migration attempts to check those other services' row visibility — that is
-- exactly the deliberate limitation ARCH-023 §5 documents, resolved instead
-- by the calling service (voting-service, proposal-service, civic-duty-
-- service per srv-002.md "Dependencies: Read by") over an HTTP integration
-- seam before it opens its own database transaction. This service has no
-- unresolved seam of its own to document here — it only ever produces this
-- data, it never needs to consume another service's data to authorize a
-- local write.
--
-- No table in this service qualifies as APPEND_ONLY (ARCH-023 §4.4) — none of
-- jurisdiction/residency/jurisdiction_membership are audit_log/ballot/
-- ledger_entry-shaped immutable-history tables, and no tbl-NNN.md Notes
-- section for this service calls out append-only semantics.
-- ============================================================================
