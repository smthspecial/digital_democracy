-- SRV-004 proposal-service — initial schema, roles, and RLS policies.
-- Implements ADR-024 / ARCH-023 for this service's own dedicated Postgres database.
-- Owned tables (per srv-004.md): TBL-008 proposal, TBL-009 proposal_constraint, TBL-010 proposal_budget.

-- ============================================================================
-- 0. Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- ============================================================================
-- 1. Roles (ARCH-023 §2) — idempotent
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'proposal_app') THEN
    CREATE ROLE proposal_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'proposal_worker') THEN
    CREATE ROLE proposal_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO proposal_app, proposal_worker;

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

-- TBL-008 proposal.status — the full lifecycle state machine (srv-004.md key rules):
-- draft -> gathering_support -> development -> voting -> approved | rejected | archived
CREATE TYPE proposal_status AS ENUM (
  'draft', 'gathering_support', 'development', 'voting', 'approved', 'rejected', 'archived'
);

-- ============================================================================
-- 4. Tables
-- ============================================================================

-- TBL-008 proposal — lifecycle status, scope, support counts, thresholds.
-- relations: problem_id -> TBL-006 problem (problem-service, cross-service, unenforced);
--            author_id  -> TBL-001 citizen (identity-service, cross-service, unenforced);
--            scope_jurisdiction_id -> TBL-003 jurisdiction (jurisdiction-service, cross-service, unenforced)
CREATE TABLE proposal (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_id             uuid NOT NULL, -- cross-service ref: problem(id) in problem-service's own DB;
                                         -- no FK per ADR-015 (no cross-database FKs)
  author_id              uuid NOT NULL, -- cross-service ref: citizen(id) in identity-service's own DB;
                                         -- no FK per ADR-015
  title                  text NOT NULL,
  description            text NOT NULL,
  -- Judgment call: nullable. "Assigned impact scope" (tbl-008.md) plus DP-030's async
  -- "Impact scope assignment routing" (srv-004.md Operations) means this is unset at
  -- creation and filled in later; the FR-008 gate before voting checks it IS set, which
  -- would be a no-op if the schema forced it NOT NULL from the start.
  scope_jurisdiction_id  uuid NULL, -- cross-service ref: jurisdiction(id) in jurisdiction-service's own DB;
                                     -- no FK per ADR-015
  support_count          integer NOT NULL DEFAULT 0,
  -- Judgment call: nullable. FR-017's population-scaled threshold is derived from
  -- scope_jurisdiction_id, which itself may not be assigned yet (see above); the
  -- threshold cannot be computed before that assignment lands.
  support_threshold      integer NULL,
  status                 proposal_status NOT NULL DEFAULT 'draft',
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_support_count_nonneg CHECK (support_count >= 0),
  CONSTRAINT proposal_support_threshold_positive CHECK (support_threshold IS NULL OR support_threshold > 0)
);

-- TBL-009 proposal_constraint — agreed constraints preceding solution design.
-- relations: proposal_id -> TBL-008 proposal (this service — real FK)
CREATE TABLE proposal_constraint (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES proposal(id) ON DELETE RESTRICT,
  text        text NOT NULL,
  agreed      boolean NOT NULL DEFAULT false
);

-- TBL-010 proposal_budget — cost, funding source, maintenance and long-term costs.
-- relations: proposal_id -> TBL-008 proposal (this service — real FK);
--            funding_category_id -> TBL-026 budget_category (budget-service, cross-service, unenforced)
CREATE TABLE proposal_budget (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Judgment call: UNIQUE. srv-004.md's completeness gate reads "proposal_budget is
  -- complete" (singular), and every column here ("cost", "funding_source", the
  -- Description column headers) is phrased as the one funding picture for the
  -- proposal, not an itemized line among several — treated as a 1:1 relationship.
  proposal_id          uuid NOT NULL UNIQUE REFERENCES proposal(id) ON DELETE RESTRICT,
  -- Judgment call: cost, funding_source, maintenance_cost, expected_benefits are nullable.
  -- srv-004.md's gate explicitly checks these four are "non-null" before development ->
  -- voting (FR-008, FR-037) — a check that is only meaningful if the schema allows them
  -- to start absent (DP-007 "Add budget info" fills them in after proposal creation).
  cost                 numeric NULL,
  funding_source       text NULL,
  -- Judgment call: nullable and not part of the FR-037 completeness gate list above;
  -- treated as optional supplementary detail.
  funding_category_id  uuid NULL, -- cross-service ref: budget_category(id) in budget-service's own DB;
                                   -- no FK per ADR-015
  maintenance_cost     numeric NULL,
  -- Judgment call: nullable and not part of the FR-037 completeness gate list above.
  long_term_cost       numeric NULL,
  expected_benefits    text NULL,
  CONSTRAINT proposal_budget_cost_nonneg CHECK (cost IS NULL OR cost >= 0),
  CONSTRAINT proposal_budget_maintenance_cost_nonneg CHECK (maintenance_cost IS NULL OR maintenance_cost >= 0),
  CONSTRAINT proposal_budget_long_term_cost_nonneg CHECK (long_term_cost IS NULL OR long_term_cost >= 0)
);

-- ============================================================================
-- 5. Row-level security
-- ============================================================================

ALTER TABLE proposal ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal FORCE ROW LEVEL SECURITY;

ALTER TABLE proposal_constraint ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_constraint FORCE ROW LEVEL SECURITY;

ALTER TABLE proposal_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_budget FORCE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 5a. proposal — ARCH-023 §6: PUBLIC read + OWN write. author_id = current_citizen_id()
--     for update; any active citizen may insert (becomes author). Cross-service scopes
--     this table cannot check locally (ARCH-023 §5): jurisdiction:member/affected against
--     scope_jurisdiction_id (jurisdiction-service's data) — left to the calling handler's
--     HTTP seam, same as ARCH-010/011/012's existing pattern; not faked here.
-- ----------------------------------------------------------------------------

CREATE POLICY proposal_public_read ON proposal
  FOR SELECT TO proposal_app, proposal_worker
  USING (true);

CREATE POLICY proposal_own_insert ON proposal
  FOR INSERT TO proposal_app
  WITH CHECK (author_id = current_citizen_id());

CREATE POLICY proposal_own_update ON proposal
  FOR UPDATE TO proposal_app
  USING (author_id = current_citizen_id())
  WITH CHECK (author_id = current_citizen_id());

CREATE POLICY proposal_worker_all ON proposal
  FOR ALL TO proposal_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON proposal TO proposal_app;
GRANT SELECT, INSERT, UPDATE ON proposal TO proposal_worker; -- never DELETE (ARCH-023 §2)

-- ----------------------------------------------------------------------------
-- 5b. proposal_constraint — ARCH-023 §6: PUBLIC read + local-parent OWN write.
--     §4.1 EXISTS variant against proposal.author_id (proposal-service owns both tables).
-- ----------------------------------------------------------------------------

CREATE POLICY proposal_constraint_public_read ON proposal_constraint
  FOR SELECT TO proposal_app, proposal_worker
  USING (true);

CREATE POLICY proposal_constraint_own_insert ON proposal_constraint
  FOR INSERT TO proposal_app
  WITH CHECK (EXISTS (
    SELECT 1 FROM proposal p
    WHERE p.id = proposal_constraint.proposal_id AND p.author_id = current_citizen_id()
  ));

CREATE POLICY proposal_constraint_own_update ON proposal_constraint
  FOR UPDATE TO proposal_app
  USING (EXISTS (
    SELECT 1 FROM proposal p
    WHERE p.id = proposal_constraint.proposal_id AND p.author_id = current_citizen_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM proposal p
    WHERE p.id = proposal_constraint.proposal_id AND p.author_id = current_citizen_id()
  ));

CREATE POLICY proposal_constraint_worker_all ON proposal_constraint
  FOR ALL TO proposal_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON proposal_constraint TO proposal_app;
GRANT SELECT, INSERT, UPDATE ON proposal_constraint TO proposal_worker; -- never DELETE (ARCH-023 §2)

-- ----------------------------------------------------------------------------
-- 5c. proposal_budget — ARCH-023 §6: PUBLIC read + local-parent OWN write.
--     §4.1 EXISTS variant against proposal.author_id (proposal-service owns both tables).
-- ----------------------------------------------------------------------------

CREATE POLICY proposal_budget_public_read ON proposal_budget
  FOR SELECT TO proposal_app, proposal_worker
  USING (true);

CREATE POLICY proposal_budget_own_insert ON proposal_budget
  FOR INSERT TO proposal_app
  WITH CHECK (EXISTS (
    SELECT 1 FROM proposal p
    WHERE p.id = proposal_budget.proposal_id AND p.author_id = current_citizen_id()
  ));

CREATE POLICY proposal_budget_own_update ON proposal_budget
  FOR UPDATE TO proposal_app
  USING (EXISTS (
    SELECT 1 FROM proposal p
    WHERE p.id = proposal_budget.proposal_id AND p.author_id = current_citizen_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM proposal p
    WHERE p.id = proposal_budget.proposal_id AND p.author_id = current_citizen_id()
  ));

CREATE POLICY proposal_budget_worker_all ON proposal_budget
  FOR ALL TO proposal_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON proposal_budget TO proposal_app;
GRANT SELECT, INSERT, UPDATE ON proposal_budget TO proposal_worker; -- never DELETE (ARCH-023 §2)
