-- SRV-003 problem-service — initial schema, roles, and RLS policies.
-- Implements ADR-024 / ARCH-023 for this service's dedicated Postgres database.
-- Owned tables (per SRV-003 / ARCH-023 §6): TBL-006 problem, TBL-007 problem_support.

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- 1. Roles (ARCH-023 §2) — idempotent, so re-running this migration against
--    a database that already has the roles is a no-op rather than an error.
--    Login credentials (passwords) are provisioned out-of-band by whatever
--    secrets pipeline wires this service to Postgres; not hard-coded here.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'problem_app') THEN
    CREATE ROLE problem_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'problem_worker') THEN
    CREATE ROLE problem_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- Lock down the default public grant, then open USAGE explicitly to the two
-- roles this service actually uses (ARCH-023 §2).
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO problem_app, problem_worker;

-- ---------------------------------------------------------------------------
-- 2. Session-context helper (ARCH-023 §3)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;

-- app.actor_role is set alongside app.citizen_id per ARCH-023 §3 but no
-- policy in this pass keys off it yet; no helper needed until one does.

-- ---------------------------------------------------------------------------
-- 3. Enum types
-- ---------------------------------------------------------------------------

-- TBL-006 problem.status
CREATE TYPE problem_status AS ENUM ('open', 'proposing', 'closed');

-- ---------------------------------------------------------------------------
-- 4. Tables
-- ---------------------------------------------------------------------------

-- TBL-006 problem — FR-015/FR-016.
CREATE TABLE problem (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- author_id: TBL-006 relations -> TBL-001 citizen, owned by identity-service
  -- (a different service database). Per ADR-015, cross-database FKs are
  -- forbidden; this is an intentionally-unenforced cross-service reference,
  -- resolved by the application layer (auth-service-issued citizen id),
  -- not by a Postgres FOREIGN KEY. (ARCH-023's §6 classification calls this
  -- column `submitted_by` in prose; tbl-006.md's actual documented column
  -- name is `author_id`, which is what this migration follows.)
  author_id       uuid NOT NULL,
  title           text NOT NULL,
  description     text NOT NULL,
  affected_area   text NOT NULL,
  -- jurisdiction_id: TBL-006 relations -> TBL-003 jurisdiction, owned by
  -- jurisdiction-service (a different service database) — same
  -- intentionally-unenforced cross-service reference as author_id above.
  jurisdiction_id uuid NOT NULL,
  status          problem_status NOT NULL DEFAULT 'open',
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- TBL-007 problem_support — FR-016/FR-017.
CREATE TABLE problem_support (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- problem_id: TBL-007 relations -> TBL-006 problem, owned by this same
  -- service (problem-service) — real FK, enforced.
  problem_id uuid NOT NULL REFERENCES problem (id) ON DELETE RESTRICT,
  -- citizen_id: TBL-007 relations -> TBL-001 citizen, owned by
  -- identity-service (a different service database) — intentionally
  -- unenforced cross-service reference, same as problem.author_id above.
  citizen_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- SRV-003 key rules / tbl-007.md Notes: "one endorsement per citizen per
  -- problem" — one-per-citizen-per-resource invariant.
  CONSTRAINT problem_support_unique_per_citizen UNIQUE (problem_id, citizen_id)
);

-- ---------------------------------------------------------------------------
-- 5. Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE problem ENABLE ROW LEVEL SECURITY;
ALTER TABLE problem FORCE ROW LEVEL SECURITY;

ALTER TABLE problem_support ENABLE ROW LEVEL SECURITY;
ALTER TABLE problem_support FORCE ROW LEVEL SECURITY;

-- --- problem: PUBLIC read (ARCH-023 §4.2); _app INSERT only, own-authored
-- (ARCH-023 §6: "TBL-006 problem | PUBLIC | read any; _app INSERT any active
-- citizen"). Status transitions (open -> proposing -> closed, SRV-003 Key
-- rules) are driven by proposal-service events observed asynchronously by
-- this service's own worker, not by the submitting citizen directly, so
-- there is deliberately no _app UPDATE policy here — only the blanket
-- _worker policy below can move status.

CREATE POLICY problem_public_read ON problem FOR SELECT
  TO problem_app, problem_worker
  USING (true);

CREATE POLICY problem_own_insert ON problem FOR INSERT
  TO problem_app
  WITH CHECK (author_id = current_citizen_id());

CREATE POLICY problem_worker_all ON problem FOR ALL
  TO problem_worker
  USING (true) WITH CHECK (true);

-- --- problem_support: PUBLIC read + OWN insert (ARCH-023 §6: "TBL-007
-- problem_support | PUBLIC read + OWN insert"). Endorsements are write-once
-- (create/withdraw semantics aren't documented), so there is no _app UPDATE
-- policy either — matches the classification table, which lists insert only.

CREATE POLICY problem_support_public_read ON problem_support FOR SELECT
  TO problem_app, problem_worker
  USING (true);

CREATE POLICY problem_support_own_insert ON problem_support FOR INSERT
  TO problem_app
  WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY problem_support_worker_all ON problem_support FOR ALL
  TO problem_worker
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 6. Grants (ARCH-023 §2: DELETE is never granted to either role in this
--    pass; neither table here is APPEND_ONLY per ARCH-023 §4.4's named list
--    or either table's own Notes section, so UPDATE is granted to
--    problem_worker for both, even though no _app policy currently uses it).
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT ON problem TO problem_app;
GRANT SELECT, INSERT, UPDATE ON problem TO problem_worker;

GRANT SELECT, INSERT ON problem_support TO problem_app;
GRANT SELECT, INSERT, UPDATE ON problem_support TO problem_worker;
