-- SRV-006 deliberation-service — initial schema, roles, and RLS policies.
-- Implements ADR-024 / ARCH-023 for this service's own dedicated Postgres database.
-- Owned tables (per srv-006.md): TBL-017 deliberation_argument, TBL-018 preference.

-- ============================================================================
-- 0. Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- ============================================================================
-- 1. Roles (ARCH-023 §2) — idempotent
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deliberation_app') THEN
    CREATE ROLE deliberation_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'deliberation_worker') THEN
    CREATE ROLE deliberation_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO deliberation_app, deliberation_worker;

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

-- TBL-017 deliberation_argument.stance (FR-033 / ADR-012: agreement vs disagreement
-- must be structurally separated)
CREATE TYPE deliberation_argument_stance AS ENUM ('agreement', 'disagreement');

-- ============================================================================
-- 4. Tables
-- ============================================================================

-- TBL-017 deliberation_argument — threaded, evidence-linked arguments on a proposal.
-- relations: proposal_id -> TBL-008 proposal (proposal-service, cross-service, unenforced);
--            author_id   -> TBL-001 citizen (identity-service, cross-service, unenforced);
--            parent_id   -> TBL-017 deliberation_argument (this service — real FK)
CREATE TABLE deliberation_argument (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id   uuid NOT NULL, -- cross-service ref: proposal(id) in proposal-service's own DB;
                                -- no FK per ADR-015 (no cross-database FKs)
  author_id     uuid NOT NULL, -- cross-service ref: citizen(id) in identity-service's own DB;
                                -- no FK per ADR-015
  -- Judgment call: parent_id is nullable even though the doc doesn't say so explicitly —
  -- "threading" requires a root argument with no parent to thread from.
  parent_id     uuid NULL REFERENCES deliberation_argument(id) ON DELETE RESTRICT,
  stance        deliberation_argument_stance NOT NULL,
  body          text NOT NULL,
  evidence_ref  text NOT NULL, -- FR-028 / srv-006.md key rule: must be non-null; rejected at write time otherwise
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Judgment call: guard against an argument being its own parent (data-integrity
  -- invariant implied by "threading" that isn't itself a business rule worth an app check).
  CONSTRAINT deliberation_argument_parent_not_self CHECK (parent_id IS NULL OR parent_id <> id)
);

-- TBL-018 preference — desired-outcome declarations, captured before solutions are proposed.
-- relations: citizen_id -> TBL-001 citizen (identity-service, cross-service, unenforced);
--            problem_id  -> TBL-006 problem (problem-service, cross-service, unenforced)
CREATE TABLE preference (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id      uuid NOT NULL, -- cross-service ref: citizen(id) in identity-service's own DB;
                                  -- no FK per ADR-015
  problem_id      uuid NOT NULL, -- cross-service ref: problem(id) in problem-service's own DB;
                                  -- no FK per ADR-015
  desired_outcome text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- One declared preference per citizen per problem. NOTE: ARCH-023 §6's row for TBL-018
  -- literally reads "UNIQUE (proposal_id, citizen_id)", but this table (per tbl-018.md and
  -- srv-006.md's own key rule: "the problem_id reference ensures preferences are tied to the
  -- problem, not a particular proposal") has no proposal_id column at all — only problem_id.
  -- Treated as a copy-paste artifact from the TBL-007 row directly above it in that table;
  -- the constraint is implemented against the column that actually exists: problem_id.
  CONSTRAINT preference_one_per_citizen_per_problem UNIQUE (problem_id, citizen_id)
);

-- ============================================================================
-- 5. Row-level security
-- ============================================================================

ALTER TABLE deliberation_argument ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliberation_argument FORCE ROW LEVEL SECURITY;

ALTER TABLE preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE preference FORCE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 5a. deliberation_argument — ARCH-023 §6: PUBLIC (read any; _app INSERT any
--     active/authenticated citizen, becomes author). No _app UPDATE policy:
--     posting is authenticated-insert-only; locking a branch to prevent
--     re-litigation (srv-006.md) is a review-body/system action, left to
--     deliberation_worker's blanket policy — the table has no "locked" column
--     documented in tbl-017.md, so nothing further to gate here yet.
-- ----------------------------------------------------------------------------

CREATE POLICY deliberation_argument_public_read ON deliberation_argument
  FOR SELECT TO deliberation_app, deliberation_worker
  USING (true);

CREATE POLICY deliberation_argument_authenticated_insert ON deliberation_argument
  FOR INSERT TO deliberation_app
  WITH CHECK (author_id = current_citizen_id());

CREATE POLICY deliberation_argument_worker_all ON deliberation_argument
  FOR ALL TO deliberation_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON deliberation_argument TO deliberation_app;
GRANT SELECT, INSERT, UPDATE ON deliberation_argument TO deliberation_worker; -- never DELETE (ARCH-023 §2)

-- ----------------------------------------------------------------------------
-- 5b. preference — ARCH-023 §6: PUBLIC read + OWN insert (citizen_id).
--     No _app UPDATE policy: a preference declaration is a one-time act,
--     enforced by the UNIQUE(problem_id, citizen_id) constraint above —
--     mirrors the TBL-007 problem_support / TBL-033 approval classification
--     shape, neither of which get an _app UPDATE policy either.
-- ----------------------------------------------------------------------------

CREATE POLICY preference_public_read ON preference
  FOR SELECT TO deliberation_app, deliberation_worker
  USING (true);

CREATE POLICY preference_own_insert ON preference
  FOR INSERT TO deliberation_app
  WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY preference_worker_all ON preference
  FOR ALL TO deliberation_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON preference TO deliberation_app;
GRANT SELECT, INSERT, UPDATE ON preference TO deliberation_worker; -- never DELETE (ARCH-023 §2)
