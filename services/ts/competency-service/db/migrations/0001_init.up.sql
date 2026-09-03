-- SRV-005 competency-service — initial schema, roles, and row-level security.
-- Implements ARCH-023 (RLS/consistency pattern) per ADR-024.
-- Owned tables (per srv-005.md): TBL-011 expert_domain, TBL-012 competency,
-- TBL-013 competency_challenge, TBL-014 conflict_of_interest, TBL-015 expert_assessment.

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Roles (ARCH-023 §2) — idempotent, since roles are cluster-global.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'competency_app') THEN
    CREATE ROLE competency_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'competency_worker') THEN
    CREATE ROLE competency_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO competency_app, competency_worker;

-- ---------------------------------------------------------------------------
-- 2. Session context helper (ARCH-023 §3)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- 3. Enum types (from each tbl-NNN.md's documented enum-shaped columns)
-- ---------------------------------------------------------------------------

-- TBL-012 competency.status
CREATE TYPE competency_status AS ENUM ('applied', 'active', 'rejected', 'expired', 'revoked');

-- TBL-013 competency_challenge.reason
CREATE TYPE competency_challenge_reason AS ENUM ('credentials', 'conflict', 'false_claim', 'misconduct');

-- TBL-013 competency_challenge.status
CREATE TYPE competency_challenge_status AS ENUM ('open', 'reviewing', 'upheld', 'dismissed');

-- TBL-014 conflict_of_interest.type
CREATE TYPE conflict_of_interest_type AS ENUM ('employer', 'ownership', 'consulting', 'financial');

-- ---------------------------------------------------------------------------
-- 4. Tables
-- ---------------------------------------------------------------------------

-- TBL-011 expert_domain — independent competency domain catalog (FR-021).
CREATE TABLE expert_domain (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text NOT NULL,
  -- JUDGMENT CALL: tbl-011.md's Notes don't spell out uniqueness explicitly, but
  -- "independent competency domains" (FR-021) only holds if the catalog has no
  -- duplicate entries for the same domain — enforced here rather than left to
  -- application code.
  CONSTRAINT expert_domain_name_key UNIQUE (name)
);

-- TBL-012 competency — per-citizen per-domain credential (FR-021, FR-022, FR-026).
CREATE TABLE competency (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- citizen_id references identity-service's citizen (TBL-001) — cross-service,
  -- intentionally not a FK: ADR-015 forbids cross-database foreign keys.
  citizen_id  uuid NOT NULL,
  domain_id   uuid NOT NULL REFERENCES expert_domain(id) ON DELETE RESTRICT,
  level       smallint NOT NULL CHECK (level BETWEEN 0 AND 4),
  status      competency_status NOT NULL DEFAULT 'applied',
  -- JUDGMENT CALL: granted_at/expires_at are nullable, not NOT NULL. tbl-012.md
  -- doesn't mark them nullable, but the documented lifecycle (applied -> active
  -- or rejected; FR-022's five-stage pipeline) means a row can exist before any
  -- grant has happened — forcing NOT NULL here would make 'applied'/'rejected'
  -- rows impossible to represent.
  granted_at  timestamptz,
  expires_at  timestamptz,
  CONSTRAINT competency_expiry_after_grant CHECK (
    granted_at IS NULL OR expires_at IS NULL OR expires_at > granted_at
  )
);

CREATE INDEX competency_citizen_id_idx ON competency (citizen_id);
CREATE INDEX competency_domain_id_idx ON competency (domain_id);

-- JUDGMENT CALL: tbl-012.md's Notes don't state this explicitly, but "domain-
-- specific" credential (FR-021) implies a citizen shouldn't hold two
-- simultaneously-active competencies in the same domain; a partial unique
-- index enforces that without blocking re-application after rejection/expiry.
CREATE UNIQUE INDEX competency_one_active_per_domain
  ON competency (citizen_id, domain_id) WHERE status = 'active';

-- TBL-013 competency_challenge — public challenge records (FR-024).
CREATE TABLE competency_challenge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competency_id uuid NOT NULL REFERENCES competency(id) ON DELETE RESTRICT,
  -- challenger_id references identity-service's citizen (TBL-001) — cross-service,
  -- intentionally not a FK: ADR-015 forbids cross-database foreign keys.
  challenger_id uuid NOT NULL,
  evidence_ref  text NOT NULL,
  reason        competency_challenge_reason NOT NULL,
  status        competency_challenge_status NOT NULL DEFAULT 'open',
  -- JUDGMENT CALL: decision is nullable — tbl-013.md describes it as "public
  -- decision rationale", which only exists once status leaves 'open'/'reviewing'.
  decision      text
);

CREATE INDEX competency_challenge_competency_id_idx ON competency_challenge (competency_id);
CREATE INDEX competency_challenge_challenger_id_idx ON competency_challenge (challenger_id);

-- TBL-014 conflict_of_interest — disclosed interests (FR-025, FR-063).
CREATE TABLE conflict_of_interest (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- citizen_id references identity-service's citizen (TBL-001) — cross-service,
  -- intentionally not a FK: ADR-015 forbids cross-database foreign keys.
  citizen_id   uuid NOT NULL,
  domain_id    uuid NOT NULL REFERENCES expert_domain(id) ON DELETE RESTRICT,
  type         conflict_of_interest_type NOT NULL,
  description  text NOT NULL,
  disclosed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX conflict_of_interest_citizen_id_idx ON conflict_of_interest (citizen_id);
CREATE INDEX conflict_of_interest_domain_id_idx ON conflict_of_interest (domain_id);

-- TBL-015 expert_assessment — advisory analyses on proposals (FR-023, ADR-007).
CREATE TABLE expert_assessment (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- proposal_id references proposal-service's proposal (TBL-008) — cross-service,
  -- intentionally not a FK: ADR-015 forbids cross-database foreign keys.
  proposal_id           uuid NOT NULL,
  -- expert_id references identity-service's citizen (TBL-001) — cross-service,
  -- intentionally not a FK: ADR-015 forbids cross-database foreign keys.
  expert_id             uuid NOT NULL,
  domain_id             uuid NOT NULL REFERENCES expert_domain(id) ON DELETE RESTRICT,
  technical_score       smallint NOT NULL,
  economic_score        smallint NOT NULL,
  social_score          smallint NOT NULL,
  sustainability_score  smallint NOT NULL,
  body                  text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX expert_assessment_proposal_id_idx ON expert_assessment (proposal_id);
CREATE INDEX expert_assessment_expert_id_idx ON expert_assessment (expert_id);
CREATE INDEX expert_assessment_domain_id_idx ON expert_assessment (domain_id);

-- ---------------------------------------------------------------------------
-- 5. Row-level security — enable + force on every table, no exceptions.
-- ---------------------------------------------------------------------------

ALTER TABLE expert_domain ENABLE ROW LEVEL SECURITY;
ALTER TABLE expert_domain FORCE ROW LEVEL SECURITY;

ALTER TABLE competency ENABLE ROW LEVEL SECURITY;
ALTER TABLE competency FORCE ROW LEVEL SECURITY;

ALTER TABLE competency_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE competency_challenge FORCE ROW LEVEL SECURITY;

ALTER TABLE conflict_of_interest ENABLE ROW LEVEL SECURITY;
ALTER TABLE conflict_of_interest FORCE ROW LEVEL SECURITY;

ALTER TABLE expert_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE expert_assessment FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 6. Policies (ARCH-023 §6 classification for this service's tables)
-- ---------------------------------------------------------------------------

-- expert_domain: PUBLIC — reference data, _worker-managed (ARCH-023 §6 TBL-011).
CREATE POLICY expert_domain_public_read ON expert_domain FOR SELECT
  TO competency_app, competency_worker USING (true);
CREATE POLICY expert_domain_worker_all ON expert_domain FOR ALL
  TO competency_worker USING (true) WITH CHECK (true);

-- competency: PUBLIC read + OWN write (ARCH-023 §6 TBL-012).
CREATE POLICY competency_public_read ON competency FOR SELECT
  TO competency_app, competency_worker USING (true);
CREATE POLICY competency_own_insert ON competency FOR INSERT
  TO competency_app WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY competency_own_update ON competency FOR UPDATE
  TO competency_app
  USING (citizen_id = current_citizen_id())
  WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY competency_worker_all ON competency FOR ALL
  TO competency_worker USING (true) WITH CHECK (true);

-- competency_challenge: PUBLIC read + authenticated insert, not owner-scoped
-- (ARCH-023 §6 TBL-013 — a challenge targets someone else's competency).
-- Review/decision transitions (DP-032) are worker-driven only; no app UPDATE
-- policy is defined, so a challenger cannot edit their own challenge post-submit.
CREATE POLICY competency_challenge_public_read ON competency_challenge FOR SELECT
  TO competency_app, competency_worker USING (true);
CREATE POLICY competency_challenge_auth_insert ON competency_challenge FOR INSERT
  TO competency_app WITH CHECK (challenger_id = current_citizen_id());
CREATE POLICY competency_challenge_worker_all ON competency_challenge FOR ALL
  TO competency_worker USING (true) WITH CHECK (true);

-- conflict_of_interest: OWN, self-disclosure only (ARCH-023 §6 TBL-014).
CREATE POLICY conflict_of_interest_own_select ON conflict_of_interest FOR SELECT
  TO competency_app USING (citizen_id = current_citizen_id());
CREATE POLICY conflict_of_interest_own_insert ON conflict_of_interest FOR INSERT
  TO competency_app WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY conflict_of_interest_own_update ON conflict_of_interest FOR UPDATE
  TO competency_app
  USING (citizen_id = current_citizen_id())
  WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY conflict_of_interest_worker_all ON conflict_of_interest FOR ALL
  TO competency_worker USING (true) WITH CHECK (true);

-- expert_assessment: PUBLIC read + local domain-match write (ARCH-023 §6 TBL-015
-- and §4.1's EXISTS variant) — the assessor must hold an active competency in
-- the assessed domain. FR-025's undisclosed-conflict-of-interest block is a
-- business-rule condition (coi.none), not a row-visibility check, and per
-- ARCH-023 §5 stays enforced in application code, not RLS.
CREATE POLICY expert_assessment_public_read ON expert_assessment FOR SELECT
  TO competency_app, competency_worker USING (true);
CREATE POLICY expert_assessment_domain_match_insert ON expert_assessment FOR INSERT
  TO competency_app WITH CHECK (
    expert_id = current_citizen_id()
    AND EXISTS (
      SELECT 1 FROM competency c
      WHERE c.citizen_id = current_citizen_id()
        AND c.domain_id = expert_assessment.domain_id
        AND c.status = 'active'
    )
  );
CREATE POLICY expert_assessment_worker_all ON expert_assessment FOR ALL
  TO competency_worker USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 7. Table grants (SELECT/INSERT/UPDATE only — DELETE is never granted, §2).
-- ---------------------------------------------------------------------------

GRANT SELECT ON expert_domain TO competency_app;
GRANT SELECT, INSERT, UPDATE ON expert_domain TO competency_worker;

GRANT SELECT, INSERT, UPDATE ON competency TO competency_app;
GRANT SELECT, INSERT, UPDATE ON competency TO competency_worker;

GRANT SELECT, INSERT ON competency_challenge TO competency_app;
GRANT SELECT, INSERT, UPDATE ON competency_challenge TO competency_worker;

GRANT SELECT, INSERT, UPDATE ON conflict_of_interest TO competency_app;
GRANT SELECT, INSERT, UPDATE ON conflict_of_interest TO competency_worker;

GRANT SELECT, INSERT ON expert_assessment TO competency_app;
GRANT SELECT, INSERT, UPDATE ON expert_assessment TO competency_worker;
