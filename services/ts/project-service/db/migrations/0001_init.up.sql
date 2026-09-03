-- SRV-013 project-service — initial schema, roles, and RLS policies.
-- Implements ADR-024 / ARCH-023 for this service's dedicated database.
-- Owned tables (per srv-013.md): TBL-029 project, TBL-030 project_milestone,
-- TBL-031 outcome_evaluation.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- 1. Roles (ARCH-023 §2)
-- ---------------------------------------------------------------------------
-- Passwords/auth are provisioned out-of-band via deployment secrets
-- management (e.g. ALTER ROLE ... PASSWORD run by the deploy pipeline), not
-- committed here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'project_app') THEN
    CREATE ROLE project_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'project_worker') THEN
    CREATE ROLE project_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO project_app, project_worker;

-- ---------------------------------------------------------------------------
-- 2. Session context helper (ARCH-023 §3)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;
-- app.actor_role is reserved for later use (ARCH-023 §3); no policy in this
-- pass keys off it.

-- ---------------------------------------------------------------------------
-- 3. Enum types (values copied verbatim from each tbl-NNN.md)
-- ---------------------------------------------------------------------------

CREATE TYPE project_status AS ENUM ('planned', 'in_progress', 'completed', 'cancelled'); -- TBL-029.status
CREATE TYPE milestone_status AS ENUM ('pending', 'done', 'delayed'); -- TBL-030.status
CREATE TYPE evaluation_result AS ENUM ('successful', 'partial', 'unsuccessful'); -- TBL-031.evaluation

-- ---------------------------------------------------------------------------
-- 4. Tables
-- ---------------------------------------------------------------------------

-- TBL-029 project
-- relations: proposal_id -> TBL-008 proposal, owned by proposal-service, a
-- different service database (ADR-015). No cross-database FK is possible or
-- permitted; the reference is documented here, not enforced.
CREATE TABLE project (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id      uuid NOT NULL, -- cross-service reference: proposal-service.proposal(id) — unenforced (ADR-015)
  timeline_start   date NOT NULL,
  timeline_end     date NOT NULL,
  budget_allocated numeric NOT NULL,
  budget_spent     numeric NOT NULL DEFAULT 0,
  contractor       text NOT NULL,
  status           project_status NOT NULL DEFAULT 'planned',
  CONSTRAINT project_timeline_order_chk CHECK (timeline_end >= timeline_start),
  CONSTRAINT project_budget_allocated_positive_chk CHECK (budget_allocated > 0),
  CONSTRAINT project_budget_spent_nonneg_chk CHECK (budget_spent >= 0)
);

CREATE INDEX idx_project_proposal_id ON project (proposal_id);

-- TBL-030 project_milestone
-- relations: project_id -> TBL-029 project, owned by this same service —
-- real FK, ON DELETE RESTRICT (a project's milestone history is never
-- silently dropped by deleting the parent).
CREATE TABLE project_milestone (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES project (id) ON DELETE RESTRICT,
  name         text NOT NULL,
  due_date     date NOT NULL,
  completed_at timestamptz, -- judgment call: nullable — "Actual completion" cannot be known when a milestone is created pending/delayed
  status       milestone_status NOT NULL DEFAULT 'pending',
  -- judgment call: completed_at is only meaningful once the milestone is
  -- actually done; forbids a pending/delayed row from carrying a completion
  -- timestamp it hasn't earned yet.
  CONSTRAINT project_milestone_completed_at_chk CHECK (completed_at IS NULL OR status = 'done')
);

CREATE INDEX idx_project_milestone_project_id ON project_milestone (project_id);

-- TBL-031 outcome_evaluation
-- relations: project_id -> TBL-029 project, owned by this same service —
-- real FK, ON DELETE RESTRICT (evaluation history is never silently
-- dropped by deleting the parent project).
CREATE TABLE outcome_evaluation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES project (id) ON DELETE RESTRICT,
  objective         text NOT NULL,
  promised_outcome  text NOT NULL,
  measured_outcome  text NOT NULL,
  evaluation        evaluation_result NOT NULL,
  evaluated_at      timestamptz NOT NULL
);

CREATE INDEX idx_outcome_evaluation_project_id ON outcome_evaluation (project_id);

-- ---------------------------------------------------------------------------
-- 5. Row-level security (ARCH-023 §4, §6)
-- ---------------------------------------------------------------------------

-- project — ARCH-023 §6 classifies this PUBLIC ("oversight layer is public
-- by design") without naming a writing actor. Judgment call: srv-013.md's
-- Key rules say a project row is created automatically when a proposal is
-- approved, and budget_spent is updated "by project-service itself" as
-- spend is reported (DP-018) — neither is a direct citizen action, so
-- writes are worker-only here, the same shape ARCH-023 §6 already uses for
-- TBL-003 jurisdiction and TBL-016 reputation_record (system-managed
-- reference/computed data).
ALTER TABLE project ENABLE ROW LEVEL SECURITY;
ALTER TABLE project FORCE ROW LEVEL SECURITY;

CREATE POLICY project_public_read ON project FOR SELECT
  TO project_app, project_worker
  USING (true);

CREATE POLICY project_worker_all ON project FOR ALL
  TO project_worker
  USING (true) WITH CHECK (true);

GRANT SELECT ON project TO project_app;
GRANT SELECT, INSERT, UPDATE ON project TO project_worker;

-- project_milestone — ARCH-023 §6: PUBLIC read + worker write. The
-- `assigned` scope (civic-duty-service's civic_assignment, i.e. who is
-- authorized to report on this milestone) is cross-service and cannot be
-- resolved by a local RLS policy (ARCH-023 §5) — the HTTP handler must
-- resolve that assignment check over the wire before writing under
-- project_worker, which is already-authorized at that point (§4.3).
ALTER TABLE project_milestone ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_milestone FORCE ROW LEVEL SECURITY;

CREATE POLICY project_milestone_public_read ON project_milestone FOR SELECT
  TO project_app, project_worker
  USING (true);

CREATE POLICY project_milestone_worker_all ON project_milestone FOR ALL
  TO project_worker
  USING (true) WITH CHECK (true);

GRANT SELECT ON project_milestone TO project_app;
GRANT SELECT, INSERT, UPDATE ON project_milestone TO project_worker;

-- outcome_evaluation — ARCH-023 §6: PUBLIC read + worker write, same
-- cross-service note as project_milestone (the reviewing/evaluating role
-- comes from civic-duty-service's assignment; resolved over HTTP before the
-- worker-role write, not locally checkable per §5).
ALTER TABLE outcome_evaluation ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_evaluation FORCE ROW LEVEL SECURITY;

CREATE POLICY outcome_evaluation_public_read ON outcome_evaluation FOR SELECT
  TO project_app, project_worker
  USING (true);

CREATE POLICY outcome_evaluation_worker_all ON outcome_evaluation FOR ALL
  TO project_worker
  USING (true) WITH CHECK (true);

GRANT SELECT ON outcome_evaluation TO project_app;
GRANT SELECT, INSERT, UPDATE ON outcome_evaluation TO project_worker;

-- None of this service's tables are APPEND_ONLY (audit_log/ballot/
-- ledger_entry live in other services' databases) — ARCH-023 §4.4 does not
-- apply to any table in this pass.
