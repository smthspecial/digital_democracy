-- 0001_init.up.sql — budget-service (SRV-007)
-- Implements ADR-024 / ARCH-023: two Postgres roles, RLS forced on every
-- table, and the schema for this service's three owned tables:
--   TBL-026 budget_category, TBL-027 budget_allocation_vote, TBL-028 ledger_entry.
--
-- Per ARCH-023 §5, cross-service relations (jurisdiction_id -> jurisdiction,
-- citizen_id -> citizen, project_id -> project) are intentionally NOT
-- foreign keys: ADR-015 forbids cross-database FKs. They are documented
-- inline as comments instead.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Roles (ARCH-023 §2)
-- ---------------------------------------------------------------------------
-- Login credentials (passwords) are provisioned out-of-band by whatever
-- future work actually wires this service to Postgres (ADR-024 §Consequences);
-- this migration only establishes the role shape and its privileges.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'budget_app') THEN
    CREATE ROLE budget_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'budget_worker') THEN
    CREATE ROLE budget_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO budget_app, budget_worker;

-- ---------------------------------------------------------------------------
-- 2. Session context helper (ARCH-023 §3)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- 3. Enum types
-- ---------------------------------------------------------------------------

-- TBL-028 ledger_entry.direction: "enum | inflow | outflow"
CREATE TYPE ledger_entry_direction AS ENUM ('inflow', 'outflow');

-- ---------------------------------------------------------------------------
-- 4. Tables
-- ---------------------------------------------------------------------------

-- TBL-026 budget_category — hierarchical category tree per jurisdiction.
-- Classification (ARCH-023 §6): PUBLIC, reference data, _worker-managed.
CREATE TABLE budget_category (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Cross-service reference to jurisdiction (TBL-003, jurisdiction-service).
  -- Not a FK: ADR-015 forbids cross-database foreign keys (ARCH-023 §5).
  jurisdiction_id   uuid NOT NULL,
  -- Self-referential, same-service FK: hierarchical parent (srv-007.md
  -- "budget_category is hierarchical (self-referential parent_id)").
  parent_id         uuid REFERENCES budget_category(id) ON DELETE RESTRICT,
  name              text NOT NULL,
  -- Money field; DP-051 writes the aggregated allocation back here. A
  -- category with no votes yet starts at 0 rather than NULL.
  allocated_amount  numeric NOT NULL DEFAULT 0 CHECK (allocated_amount >= 0)
);

CREATE INDEX budget_category_jurisdiction_id_idx ON budget_category(jurisdiction_id);
CREATE INDEX budget_category_parent_id_idx ON budget_category(parent_id);

-- TBL-027 budget_allocation_vote — citizen percentage preferences per
-- category per period.
-- Classification (ARCH-023 §6): OWN — treated as vote-adjacent, defaults
-- private like a ballot rather than public.
CREATE TABLE budget_allocation_vote (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Cross-service reference to citizen (TBL-001, identity-service).
  -- Not a FK: ADR-015 forbids cross-database foreign keys (ARCH-023 §5).
  citizen_id   uuid NOT NULL,
  -- Same-service FK: budget_category is also owned by budget-service.
  category_id  uuid NOT NULL REFERENCES budget_category(id) ON DELETE RESTRICT,
  percentage   numeric NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  period       text NOT NULL,
  -- srv-007.md: "budget_allocation_vote is unique per (citizen_id, category_id, period)."
  UNIQUE (citizen_id, category_id, period)
  -- NOTE: "totals per citizen per period must sum to 100%" (srv-007.md) is a
  -- cross-row aggregate invariant, not a single-row CHECK — it stays enforced
  -- at write time in application code (ARCH-023 §5's "totals:100" condition
  -- token stays outside RLS/DB constraints), same as DP-013 does today.
);

CREATE INDEX budget_allocation_vote_category_period_idx ON budget_allocation_vote(category_id, period);

-- TBL-028 ledger_entry — immutable inflow/outflow records (FR-036 public ledger).
-- Classification (ARCH-023 §6): PUBLIC + APPEND_ONLY; _worker-only insert
-- (AUTH-006 operator, DP-019).
CREATE TABLE ledger_entry (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Cross-service reference to jurisdiction (TBL-003, jurisdiction-service).
  -- Not a FK: ADR-015 forbids cross-database foreign keys (ARCH-023 §5).
  jurisdiction_id  uuid NOT NULL,
  -- Same-service FK: budget_category is also owned by budget-service.
  -- tbl-028.md does not mark category_id nullable (only project_id is).
  category_id      uuid NOT NULL REFERENCES budget_category(id) ON DELETE RESTRICT,
  -- Cross-service reference to project (TBL-029, project-service), nullable
  -- per tbl-028.md. Not a FK: ADR-015 forbids cross-database foreign keys.
  project_id       uuid,
  direction        ledger_entry_direction NOT NULL,
  amount           numeric NOT NULL CHECK (amount > 0),
  source           text NOT NULL,
  occurred_at      timestamptz NOT NULL
);

CREATE INDEX ledger_entry_jurisdiction_id_idx ON ledger_entry(jurisdiction_id);
CREATE INDEX ledger_entry_category_id_idx ON ledger_entry(category_id);
CREATE INDEX ledger_entry_project_id_idx ON ledger_entry(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX ledger_entry_occurred_at_idx ON ledger_entry(occurred_at);

-- ---------------------------------------------------------------------------
-- 5. Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE budget_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_category FORCE ROW LEVEL SECURITY;

ALTER TABLE budget_allocation_vote ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_allocation_vote FORCE ROW LEVEL SECURITY;

ALTER TABLE ledger_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry FORCE ROW LEVEL SECURITY;

-- budget_category: PUBLIC read, _worker-managed writes (reference data).
CREATE POLICY budget_category_public_read ON budget_category FOR SELECT
  TO budget_app, budget_worker
  USING (true);

CREATE POLICY budget_category_worker_all ON budget_category FOR ALL
  TO budget_worker
  USING (true) WITH CHECK (true);

GRANT SELECT ON budget_category TO budget_app;
GRANT SELECT, INSERT, UPDATE ON budget_category TO budget_worker;

-- budget_allocation_vote: OWN (citizen_id) — private like a ballot, not public.
CREATE POLICY budget_allocation_vote_own_select ON budget_allocation_vote FOR SELECT
  TO budget_app
  USING (citizen_id = current_citizen_id());

CREATE POLICY budget_allocation_vote_own_insert ON budget_allocation_vote FOR INSERT
  TO budget_app
  WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY budget_allocation_vote_own_update ON budget_allocation_vote FOR UPDATE
  TO budget_app
  USING (citizen_id = current_citizen_id())
  WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY budget_allocation_vote_worker_all ON budget_allocation_vote FOR ALL
  TO budget_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON budget_allocation_vote TO budget_app;
GRANT SELECT, INSERT, UPDATE ON budget_allocation_vote TO budget_worker;

-- ledger_entry: PUBLIC read, _worker-only insert (operator-recorded, FR-036).
CREATE POLICY ledger_entry_public_read ON ledger_entry FOR SELECT
  TO budget_app, budget_worker
  USING (true);

CREATE POLICY ledger_entry_worker_all ON ledger_entry FOR ALL
  TO budget_worker
  USING (true) WITH CHECK (true);

GRANT SELECT ON ledger_entry TO budget_app;
GRANT SELECT, INSERT, UPDATE ON ledger_entry TO budget_worker;

-- ---------------------------------------------------------------------------
-- 6. APPEND_ONLY enforcement (ARCH-023 §4.4) — ledger_entry
-- ---------------------------------------------------------------------------
-- srv-007.md: "ledger_entry is append-only... No update or delete permitted;
-- corrections are new compensating entries." No role, including _worker,
-- ever gets UPDATE/DELETE, belt-and-suspenders via REVOKE + trigger.

REVOKE UPDATE, DELETE ON ledger_entry FROM budget_app, budget_worker;

CREATE OR REPLACE FUNCTION ledger_entry_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entry is append-only: % not permitted', TG_OP;
END;
$$;

CREATE TRIGGER ledger_entry_no_update BEFORE UPDATE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_forbid_mutation();
CREATE TRIGGER ledger_entry_no_delete BEFORE DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_forbid_mutation();
