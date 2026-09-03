-- SRV-014 reputation-service — initial schema, roles, and RLS policies.
-- Implements ADR-024 / ARCH-023 for this service's own dedicated Postgres database.
-- Owned tables (per srv-014.md): TBL-016 reputation_record.

-- ============================================================================
-- 0. Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- ============================================================================
-- 1. Roles (ARCH-023 §2) — idempotent
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'reputation_app') THEN
    CREATE ROLE reputation_app
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'reputation_worker') THEN
    CREATE ROLE reputation_worker
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- Lock down the default public grant, then re-open only USAGE to our two roles.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO reputation_app, reputation_worker;

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
-- 3. Enum types (from tbl-016.md's documented column values)
-- ============================================================================

-- TBL-016 reputation_record.factor_type — positive factors (FR-027) followed
-- by negative factors, matching the documented order exactly.
CREATE TYPE reputation_record_factor_type AS ENUM (
  'accurate_prediction',
  'constructive',
  'disclosure',
  'successful_proposal',
  'misinformation',
  'undisclosed_conflict',
  'manipulation',
  'fraud'
);

-- ============================================================================
-- 4. Tables
-- ============================================================================

-- ---------------------------------------------------------------------------
-- TBL-016 reputation_record — an event log: one row per factor event, never
-- a single mutable score (srv-014.md "Key rules"). Current reputation is the
-- sum of all delta values for a citizen, computed by the reader, not stored.
-- relations: citizen_id -> TBL-001 citizen (identity-service): cross-service
--            reference, intentionally NOT a FK (ADR-015 forbids cross-database
--            FKs).
-- ---------------------------------------------------------------------------
CREATE TABLE reputation_record (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id  uuid NOT NULL, -- TBL-001 citizen, owned by identity-service (SRV-001): cross-service reference, intentionally NOT a FK (ADR-015)
  factor_type reputation_record_factor_type NOT NULL,
  delta       numeric NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Judgment call: a zero delta would record an event with no reputation
  -- effect at all, which contradicts "signed reputation change" (tbl-016.md)
  -- and the event-log design (every row must actually move the sum).
  CONSTRAINT reputation_record_delta_nonzero CHECK (delta <> 0)
);

CREATE INDEX reputation_record_citizen_id_idx ON reputation_record (citizen_id);

-- Note on APPEND_ONLY (ARCH-023 §4.4): srv-014.md describes reputation_record
-- as an event log that "preserves the full history", which reads similarly to
-- ledger_entry/audit_log. However, ARCH-023 §6's own classification row for
-- TBL-016 is "PUBLIC read | _worker-only write (system-computed)" — it does
-- NOT carry the explicit "+ APPEND_ONLY" tag that row gives ledger_entry,
-- audit_log, and ballot, and tbl-016.md's own Notes section states no
-- immutability invariant either. Per that authoritative classification, this
-- migration does NOT apply the REVOKE UPDATE/DELETE + forbid-mutation-trigger
-- treatment here; write access is restricted to reputation_worker only via
-- RLS + grants below, which is what "system-computed" actually requires.

-- ============================================================================
-- 5. Row-level security (no exceptions, per ARCH-023 §4 preamble)
-- ============================================================================

ALTER TABLE reputation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE reputation_record FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- reputation_record policies — PUBLIC (ARCH-023 §4.2, §6): read any; write is
-- system-computed (DP-038) and goes through reputation_worker only. No
-- reputation_app write policy is defined — the app role can SELECT but has no
-- INSERT/UPDATE grant/policy at all, matching srv-014.md's "self-reported
-- negative deltas are not permitted" and the TBL-016 §6 row's "_worker-only
-- write (system-computed)".
-- ---------------------------------------------------------------------------
CREATE POLICY reputation_record_public_read ON reputation_record FOR SELECT
  TO reputation_app, reputation_worker
  USING (true);

CREATE POLICY reputation_record_worker_all ON reputation_record FOR ALL
  TO reputation_worker
  USING (true) WITH CHECK (true);

-- ============================================================================
-- 6. Grants (SELECT/INSERT/UPDATE only — no DELETE in this pass, ARCH-023 §2)
-- ============================================================================

GRANT SELECT ON reputation_record TO reputation_app;
GRANT SELECT, INSERT, UPDATE ON reputation_record TO reputation_worker;

-- ============================================================================
-- Note on cross-service scope limitation (ARCH-023 §5):
--
-- reputation_record's only relation (citizen_id -> TBL-001 citizen) points at
-- identity-service's own database and is intentionally left unenforced as a
-- FK (comment above, ADR-015). No AUTH-010 scope this service's own writes
-- depend on requires cross-service data to resolve locally: every write is
-- worker-only and system-computed from events srv-014.md's "Dependencies"
-- section says arrive already-authorized from voting-service, project-
-- service, competency-service, and deliberation-service (each has already
-- resolved its own authorization before emitting the event that triggers
-- DP-038) — there is no unresolved cross-service seam of this service's own
-- left open here.
--
-- No table in this service qualifies as APPEND_ONLY (ARCH-023 §4.4) per the
-- judgment call documented above the table definition.
-- ============================================================================
