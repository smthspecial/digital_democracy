-- SRV-018 iam-service — initial schema, roles, and RLS policies.
-- Implements ADR-025 / ARCH-024 (policy schema, dual-control flow) for this
-- service's own dedicated Postgres database, following ARCH-023's pattern
-- exactly (two roles, session GUC helper, RLS forced on every table).
-- Owned tables (per srv-018.md): TBL-040 access_policy,
-- TBL-041 policy_attachment, TBL-042 policy_endorsement.

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- 1. Roles (ARCH-023 §2) — idempotent
-- ---------------------------------------------------------------------------
-- Passwords/auth are provisioned out-of-band via deployment secrets
-- management, not committed here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iam_app') THEN
    CREATE ROLE iam_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iam_worker') THEN
    CREATE ROLE iam_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO iam_app, iam_worker;

-- ---------------------------------------------------------------------------
-- 2. Session-context helper (ARCH-023 §3)
-- ---------------------------------------------------------------------------
-- Defined per convention even though no table in this pass carries an
-- OWN-scoped citizen_id column: every write in this service requires a live
-- cross-service check against governance-role-service (proposer/endorser/
-- revoker role_type + term liveness, ARCH-024 §2/§5) resolved by the HTTP
-- handler before it writes as iam_worker — the same worker-write-only shape
-- ARCH-023 §5/§6 already establishes for project_milestone, outcome_evaluation,
-- and constitutional_review. Kept so a future policy needing it doesn't
-- require touching this migration.

CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;
-- app.actor_role is reserved for later use (ARCH-023 §3); no policy in this
-- pass keys off it.

-- ---------------------------------------------------------------------------
-- 3. Enum types (values copied verbatim from each tbl-NNN.md)
-- ---------------------------------------------------------------------------

CREATE TYPE access_policy_effect AS ENUM ('allow', 'deny'); -- TBL-040.effect

-- TBL-040.status. Note: ARCH-024 §5 describes a 'rejected' outcome for "the
-- target's status" generically on a rejected endorsement, but TBL-040's own
-- documented status list is the one actually implemented here.
CREATE TYPE access_policy_status AS ENUM (
  'pending_approval', 'active', 'rejected', 'revoked'
);

-- TBL-041.status — judgment call: TBL-041's documented enum list has no
-- 'rejected' value (unlike TBL-040's), even though ARCH-024 §5 / DP-070
-- describe a rejected-endorsement path for attachments too. Implemented
-- exactly as TBL-041 documents it rather than silently adding a value the
-- table spec doesn't list; flag for spec follow-up if a rejected-attachment
-- state is actually needed.
CREATE TYPE policy_attachment_status AS ENUM (
  'pending_approval', 'active', 'revoked'
);

CREATE TYPE policy_endorsement_target_type AS ENUM ('policy', 'attachment'); -- TBL-042.target_type
CREATE TYPE policy_endorsement_decision AS ENUM ('approved', 'rejected'); -- TBL-042.decision

-- ---------------------------------------------------------------------------
-- 4. Tables
-- ---------------------------------------------------------------------------

-- TBL-040 access_policy
-- proposed_by is a cross-service reference to citizen(id) (TBL-001,
-- identity-service) — a DIFFERENT service database. Per ADR-015
-- (database-per-service) and ARCH-023 §5, cross-database FKs are not
-- available; verified live against governance-role-service instead
-- (ARCH-024 §2), never joined locally.
CREATE TABLE access_policy (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  effect      access_policy_effect NOT NULL,
  actions     text[] NOT NULL,
  resources   text[] NOT NULL,
  conditions  jsonb, -- nullable: null means unconditional (TBL-040 Notes)
  description text NOT NULL,
  status      access_policy_status NOT NULL DEFAULT 'pending_approval',
  proposed_by uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN access_policy.proposed_by IS
  'Cross-service reference to citizen(id) (TBL-001, identity-service). Not FK-enforced: ADR-015 forbids cross-database FKs; role/term verified live against governance-role-service (ARCH-024 §2).';

-- TBL-041 policy_attachment
-- relations: policy_id -> TBL-040 access_policy, owned by THIS same
-- service — real FK, ON DELETE RESTRICT (an attachment must never be left
-- pointing at a silently-removed policy).
CREATE TABLE policy_attachment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id     uuid NOT NULL REFERENCES access_policy (id) ON DELETE RESTRICT,
  principal_ref text NOT NULL, -- 'citizen:<uuid>' or 'role:operator' / 'role:platform_operator' (ARCH-024 §1)
  status        policy_attachment_status NOT NULL DEFAULT 'pending_approval',
  proposed_by   uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN policy_attachment.proposed_by IS
  'Cross-service reference to citizen(id) (TBL-001, identity-service). Not FK-enforced: ADR-015 forbids cross-database FKs; role/term verified live against governance-role-service (ARCH-024 §2).';

CREATE INDEX idx_policy_attachment_policy_id ON policy_attachment (policy_id); -- FK column; not auto-indexed by Postgres
CREATE INDEX idx_policy_attachment_principal_ref ON policy_attachment (principal_ref); -- DP-071's evaluation lookup path

-- TBL-042 policy_endorsement
-- target_id is a POLYMORPHIC reference: depending on target_type it points
-- at either access_policy.id or policy_attachment.id (two different tables,
-- same service database). A single real FK cannot express an "either/or"
-- target, so target_id is deliberately left unenforced by any FK — verified
-- in application code against whichever table target_type names, the same
-- "document, don't force" treatment ARCH-023 §5 already prescribes for
-- conditions a single constraint can't capture.
CREATE TABLE policy_endorsement (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type         policy_endorsement_target_type NOT NULL,
  target_id           uuid NOT NULL,
  endorser_citizen_id uuid NOT NULL,
  decision            policy_endorsement_decision NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT policy_endorsement_unique_per_citizen_target UNIQUE (target_type, target_id, endorser_citizen_id)
);

COMMENT ON COLUMN policy_endorsement.target_id IS
  'Polymorphic reference: access_policy(id) when target_type=''policy'', policy_attachment(id) when target_type=''attachment''. No FK — a single constraint cannot express an either/or target across two tables; verified in application code.';
COMMENT ON COLUMN policy_endorsement.endorser_citizen_id IS
  'Cross-service reference to citizen(id) (TBL-001, identity-service). Not FK-enforced: ADR-015 forbids cross-database FKs; must be a different citizen than the target''s proposed_by, holding an active governance role of the same role_type — verified live against governance-role-service (ARCH-024 §2), not stored here.';

-- ---------------------------------------------------------------------------
-- 5. Row-level security (ARCH-023 §4, §6)
-- ---------------------------------------------------------------------------
-- All three tables are PUBLIC read (ADR-025/TBL-040/041/042: "publicly
-- readable", CON-005 "no hidden... no exclusive access") and worker-write-only
-- — every write (propose/endorse/revoke) requires a live cross-service
-- eligibility check against governance-role-service (ARCH-024 §2/§5) that the
-- HTTP handler resolves before opening the write under iam_worker, the same
-- shape ARCH-023 §6 already uses for project_milestone/outcome_evaluation/
-- constitutional_review. No `_app` INSERT/UPDATE policy exists on any table
-- here: a citizen never writes these tables directly, only via the service's
-- own endpoints.

ALTER TABLE access_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_policy FORCE ROW LEVEL SECURITY;

CREATE POLICY access_policy_public_read ON access_policy FOR SELECT
  TO iam_app, iam_worker
  USING (true);

CREATE POLICY access_policy_worker_all ON access_policy FOR ALL
  TO iam_worker
  USING (true) WITH CHECK (true);

ALTER TABLE policy_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_attachment FORCE ROW LEVEL SECURITY;

CREATE POLICY policy_attachment_public_read ON policy_attachment FOR SELECT
  TO iam_app, iam_worker
  USING (true);

CREATE POLICY policy_attachment_worker_all ON policy_attachment FOR ALL
  TO iam_worker
  USING (true) WITH CHECK (true);

ALTER TABLE policy_endorsement ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_endorsement FORCE ROW LEVEL SECURITY;

CREATE POLICY policy_endorsement_public_read ON policy_endorsement FOR SELECT
  TO iam_app, iam_worker
  USING (true);

CREATE POLICY policy_endorsement_worker_all ON policy_endorsement FOR ALL
  TO iam_worker
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 6. Grants (SELECT/INSERT/UPDATE only — DELETE is never granted, ARCH-023 §2)
-- ---------------------------------------------------------------------------

GRANT SELECT ON access_policy TO iam_app;
GRANT SELECT, INSERT, UPDATE ON access_policy TO iam_worker;

GRANT SELECT ON policy_attachment TO iam_app;
GRANT SELECT, INSERT, UPDATE ON policy_attachment TO iam_worker;

GRANT SELECT ON policy_endorsement TO iam_app;
GRANT SELECT, INSERT, UPDATE ON policy_endorsement TO iam_worker;

-- None of this service's tables are classified APPEND_ONLY in ARCH-023 (that
-- treatment is audit_log/ballot/ledger_entry, all owned by other services) —
-- ARCH-023 §4.4 does not apply to any table in this pass. Endorsements are
-- immutable in practice (no update path is documented in DP-070/ARCH-024),
-- but since no table-spec or ARCH-023 §6 entry classifies policy_endorsement
-- as APPEND_ONLY, the REVOKE+trigger treatment is not added here.
