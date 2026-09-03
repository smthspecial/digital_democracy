-- governance-role-service (SRV-011) — initial schema
--
-- Implements the pattern defined in ARCH-023 (roles, session GUC, RLS policy templates,
-- per-table classification) for this service's own dedicated Postgres database (ADR-015,
-- ADR-024). Owned tables (per SRV-011 `tables:` field): TBL-032 governance_role,
-- TBL-033 approval.

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- 1. Roles (ARCH-023 §2)
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'governance_role_app') THEN
    CREATE ROLE governance_role_app
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'governance_role_worker') THEN
    CREATE ROLE governance_role_worker
      LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO governance_role_app, governance_role_worker;

-- ---------------------------------------------------------------------------
-- 2. Session-context helper (ARCH-023 §3)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- 3. Enum types (TBL-032, TBL-033 column definitions)
-- ---------------------------------------------------------------------------

CREATE TYPE role_type_enum AS ENUM (
  'auditor', 'reviewer', 'oversight', 'operator', 'platform_operator', 'review_body'
);

CREATE TYPE layer_enum AS ENUM (
  'protocol', 'implementation', 'audit', 'citizen'
);

CREATE TYPE approval_type_enum AS ENUM (
  'citizen_supermajority', 'audit_confirmation', 'body_endorsement'
);

CREATE TYPE decision_enum AS ENUM (
  'approved', 'rejected'
);

-- ---------------------------------------------------------------------------
-- 4. Tables
-- ---------------------------------------------------------------------------

-- TBL-032 governance_role
CREATE TABLE governance_role (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  citizen_id   uuid NOT NULL,
  role_type    role_type_enum NOT NULL,
  layer        layer_enum NOT NULL,
  term_start   date NOT NULL,
  term_end     date NOT NULL,
  randomized   boolean NOT NULL,
  CONSTRAINT governance_role_term_bounds_check CHECK (term_end > term_start)
);

-- citizen_id (relations: citizen_id:TBL-001) references citizen(id), owned by identity-service —
-- a DIFFERENT service database. Per ADR-015 (database-per-service) and ARCH-023 §5, cross-database
-- FKs/joins are not available; this is an intentionally-unenforced cross-service reference.
COMMENT ON COLUMN governance_role.citizen_id IS
  'Cross-service reference to citizen(id) (TBL-001, identity-service). Not FK-enforced: ADR-015 forbids cross-database FKs.';

-- Judgment call: TBL-032's Notes describe a separation-of-duties invariant ("no single role holds
-- both civic-ledger authority [operator] and cluster-admin authority [platform_operator]", ADR-001)
-- that spans MULTIPLE rows for the same citizen (any two roles with overlapping terms), which is not
-- expressible as a single-row CHECK or a plain UNIQUE constraint. Consistent with ARCH-023 §5's
-- treatment of business-rule conditions that aren't row-visibility/single-row questions, this is left
-- to application logic (DP-035 role-assignment workflow), not encoded here.

-- TBL-033 approval
CREATE TABLE approval (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_ref        text NOT NULL,
  approver_role_id  uuid NOT NULL REFERENCES governance_role(id) ON DELETE RESTRICT,
  approval_type     approval_type_enum NOT NULL,
  decision          decision_enum NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Partial enforcement of SRV-011's "a single person cannot supply multiple approval types for the
  -- same action": the same governance_role row may not submit more than one decision for the same
  -- action_ref. (The stronger "same citizen via a *different* held role" case would require a join
  -- to governance_role.citizen_id per action, which UNIQUE cannot express, and stays an application
  -- check in DP-035 — see approval_own_insert policy below for the citizen-identity half of it.)
  CONSTRAINT approval_one_decision_per_role_per_action_unique UNIQUE (action_ref, approver_role_id)
);

-- approver_role_id:TBL-032 is owned by this same service — enforced above as a real FK (ON DELETE
-- RESTRICT: a governance_role with recorded approvals must not be silently removable).

-- ---------------------------------------------------------------------------
-- 5. Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE governance_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_role FORCE ROW LEVEL SECURITY;

ALTER TABLE approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval FORCE ROW LEVEL SECURITY;

-- governance_role: PUBLIC (ARCH-023 §6 TBL-032) — transparency of role/term; write is `_worker`-only
-- (DP-050 rotation, role assignment), so `_app` gets no INSERT/UPDATE policy at all.
CREATE POLICY governance_role_public_read ON governance_role FOR SELECT
  TO governance_role_app, governance_role_worker
  USING (true);

CREATE POLICY governance_role_worker_all ON governance_role FOR ALL
  TO governance_role_worker
  USING (true) WITH CHECK (true);

-- approval: PUBLIC read + OWN insert (ARCH-023 §6 TBL-033), using the §4.1 local-parent-ownership
-- EXISTS variant since approval has no citizen_id column of its own, only approver_role_id ->
-- governance_role.citizen_id.
--
-- Judgment call (ARCH-023 §6 note: "same-DB EXISTS against governance_role for term/type is a
-- natural strengthening — implement if the table's actual columns support it"): the TERM half is
-- implemented below (the citizen's governance_role must currently be within term_start/term_end at
-- decision time). No TYPE strengthening (e.g. a role_type <-> approval_type mapping such as
-- auditor -> audit_confirmation) is implemented: no such mapping is documented anywhere in
-- TBL-032/TBL-033/SRV-011, and inventing one would encode an unspecified rule rather than a
-- documented one.
CREATE POLICY approval_public_read ON approval FOR SELECT
  TO governance_role_app, governance_role_worker
  USING (true);

CREATE POLICY approval_own_insert ON approval FOR INSERT
  TO governance_role_app
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM governance_role gr
      WHERE gr.id = approver_role_id
        AND gr.citizen_id = current_citizen_id()
        AND gr.term_start <= current_date
        AND gr.term_end >= current_date
    )
  );

CREATE POLICY approval_worker_all ON approval FOR ALL
  TO governance_role_worker
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 6. Grants (SELECT/INSERT/UPDATE only — DELETE is never granted, ARCH-023 §2)
-- ---------------------------------------------------------------------------

GRANT SELECT ON governance_role TO governance_role_app;
GRANT SELECT, INSERT, UPDATE ON governance_role TO governance_role_worker;

GRANT SELECT, INSERT ON approval TO governance_role_app;
GRANT SELECT, INSERT, UPDATE ON approval TO governance_role_worker;

-- Neither TBL-032 governance_role nor TBL-033 approval is classified APPEND_ONLY in ARCH-023 §6, so
-- no REVOKE UPDATE/DELETE + forbid-mutation trigger (§4.4) applies to either table in this migration.
