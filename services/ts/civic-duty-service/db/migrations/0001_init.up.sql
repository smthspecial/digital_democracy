-- civic-duty-service (SRV-009) — initial schema
--
-- Implements the pattern defined in ARCH-023 (realizing ADR-024) for this
-- service's own dedicated Postgres database (ARCH-006 §5: one cluster per
-- service, no cross-database joins — ADR-015).
--
-- Owned tables (per srv-009.md `tables:` field):
--   TBL-024 civic_assignment      (.spec/technical/database/tbl-024.md)
--   TBL-025 participation_record  (.spec/technical/database/tbl-025.md)
--
-- <svc> slug used throughout: civic_duty

-- ============================================================================
-- 0. Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ============================================================================
-- 1. Roles (ARCH-023 §2)
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'civic_duty_app') THEN
    CREATE ROLE civic_duty_app
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'civic_duty_worker') THEN
    CREATE ROLE civic_duty_worker
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- Neither role is ever granted DELETE in this pass (ARCH-023 §2): lifecycle is
-- recorded via status columns, not hard deletes.

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO civic_duty_app, civic_duty_worker;

-- ============================================================================
-- 2. Session context helper (ARCH-023 §3)
-- ============================================================================

CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;

-- app.actor_role is set alongside app.citizen_id by the application (ARCH-023
-- §3) but no policy in this service keys off it yet.

-- ============================================================================
-- 3. Enum types (from each tbl-NNN.md's documented enum columns)
-- ============================================================================

-- TBL-024 civic_assignment.type
CREATE TYPE civic_assignment_type AS ENUM (
  'proposal_review',
  'audit_review',
  'expertise_verification',
  'budget_oversight'
);

-- TBL-024 civic_assignment.status
CREATE TYPE civic_assignment_status AS ENUM (
  'assigned',
  'completed',
  'abandoned',
  'exempted'
);

-- TBL-025 participation_record.exemption_status
CREATE TYPE participation_exemption_status AS ENUM (
  'none',
  'illness',
  'disability',
  'military',
  'caregiving',
  'other'
);

-- ============================================================================
-- 4. Tables
-- ============================================================================

-- ----------------------------------------------------------------------------
-- TBL-024 civic_assignment
-- relations: citizen_id -> TBL-001 citizen (identity-service)
-- ----------------------------------------------------------------------------

CREATE TABLE civic_assignment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- References identity-service's citizen(id) (TBL-001). Cross-service:
  -- intentionally NOT enforced as a FOREIGN KEY (ADR-015 forbids
  -- cross-database FKs — identity-service owns its own Postgres cluster).
  citizen_id   uuid NOT NULL,

  type         civic_assignment_type NOT NULL,
  target_ref   text NOT NULL,

  -- DEFAULT now() is a judgment call: tbl-024.md doesn't specify a default,
  -- but the assigning process (DP-040) creates the row at the moment of
  -- assignment, so "now" is the natural default.
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  due_at       timestamptz NOT NULL,

  -- Judgment call: newly generated assignments start life in 'assigned'.
  status       civic_assignment_status NOT NULL DEFAULT 'assigned',

  -- Temporal invariant implied by "assigned_at"/"due_at" semantics: a due
  -- date can't precede the assignment that creates it.
  CONSTRAINT civic_assignment_due_after_assigned CHECK (due_at > assigned_at)
);

-- ----------------------------------------------------------------------------
-- TBL-025 participation_record
-- relations: citizen_id -> TBL-001 citizen (identity-service)
-- ----------------------------------------------------------------------------

CREATE TABLE participation_record (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Cross-service reference to identity-service's citizen(id) (TBL-001);
  -- not FK-enforced, same reasoning as civic_assignment.citizen_id above.
  citizen_id        uuid NOT NULL,

  period            text NOT NULL,
  score             numeric NOT NULL DEFAULT 0,
  quota_target      numeric NOT NULL,
  exemption_status  participation_exemption_status NOT NULL DEFAULT 'none',
  inactivity_stage  smallint NOT NULL DEFAULT 0,

  -- srv-009.md: "participation_record is written monthly by DP-048" — one
  -- record per citizen per period. Not spelled out verbatim in tbl-025.md's
  -- own Notes section, but implied by the column semantics plus srv-009's
  -- monthly-write cadence; added here as a judgment call.
  CONSTRAINT participation_record_citizen_period_unique UNIQUE (citizen_id, period),

  -- Judgment call: enforce the documented "YYYY-MM" period format.
  CONSTRAINT participation_record_period_format
    CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  -- Judgment call: score/quota are magnitudes (FR-051's 2-4 hr/month quota,
  -- a weighted participation score) — neither is meaningfully negative.
  CONSTRAINT participation_record_score_nonneg CHECK (score >= 0),
  CONSTRAINT participation_record_quota_nonneg CHECK (quota_target >= 0),

  -- Directly from tbl-025.md's column description: "0 none, 1 reminder,
  -- 2 reduced, 3 inactive".
  CONSTRAINT participation_record_inactivity_stage_range
    CHECK (inactivity_stage BETWEEN 0 AND 3)
);

-- ============================================================================
-- 5. Row-level security
-- ============================================================================
--
-- ARCH-023 §6 classifies both of this service's tables as plain OWN:
--   TBL-024 civic_assignment     | OWN | assigned citizen only ('assigned'
--                                  scope, locally resolvable — same DB)
--   TBL-025 participation_record | OWN | private participation history
--                                  (CON-005 layer 1)
-- Neither row carries a "worker-only write" override the way TBL-016,
-- TBL-019/020, TBL-026, or TBL-032 do — so the full §4.1 OWN template
-- (SELECT/INSERT/UPDATE for the owning citizen) is applied to both, not a
-- read-only-for-app variant. This also matches AUTH-010's own-scoped,
-- citizen-facing permissions on these tables (`assignment:accept`,
-- `assignment:abandon`, `exemption:claim` — all scope `own`, condition
-- `citizen.active`, tier T2): a citizen genuinely does update their own
-- civic_assignment/participation_record rows through the `_app` path, even
-- though the *rows themselves* are predominantly created by the async
-- DP-040/DP-048 jobs running under civic_duty_worker (§4.3's blanket policy
-- covers that path on every table regardless of class).

-- ----------------------------------------------------------------------------
-- civic_assignment
-- ----------------------------------------------------------------------------

ALTER TABLE civic_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE civic_assignment FORCE ROW LEVEL SECURITY;

CREATE POLICY civic_assignment_own_select ON civic_assignment FOR SELECT TO civic_duty_app
  USING (citizen_id = current_citizen_id());
CREATE POLICY civic_assignment_own_insert ON civic_assignment FOR INSERT TO civic_duty_app
  WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY civic_assignment_own_update ON civic_assignment FOR UPDATE TO civic_duty_app
  USING (citizen_id = current_citizen_id()) WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY civic_assignment_worker_all ON civic_assignment FOR ALL TO civic_duty_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON civic_assignment TO civic_duty_app, civic_duty_worker;

-- ----------------------------------------------------------------------------
-- participation_record
-- ----------------------------------------------------------------------------

ALTER TABLE participation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE participation_record FORCE ROW LEVEL SECURITY;

CREATE POLICY participation_record_own_select ON participation_record FOR SELECT TO civic_duty_app
  USING (citizen_id = current_citizen_id());
CREATE POLICY participation_record_own_insert ON participation_record FOR INSERT TO civic_duty_app
  WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY participation_record_own_update ON participation_record FOR UPDATE TO civic_duty_app
  USING (citizen_id = current_citizen_id()) WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY participation_record_worker_all ON participation_record FOR ALL TO civic_duty_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON participation_record TO civic_duty_app, civic_duty_worker;

-- ============================================================================
-- 6. Cross-service gaps (ARCH-023 §5) — documented, not a bug
-- ============================================================================
--
-- Neither owned table needs a jurisdiction:member/affected check, and the
-- `assigned` scope this service *provides* to other services (project,
-- audit) is resolved by those services' own HTTP seams against this
-- service's data — not something this database's RLS needs to check
-- inbound. Nothing in this migration attempts to verify jurisdiction or
-- competency weighting locally; that weighting happens in application code
-- (DP-040) reading from jurisdiction-service/competency-service over HTTP,
-- per srv-009.md's Dependencies and ARCH-023 §5's table.
