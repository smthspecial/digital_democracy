-- delegation-service (SRV-010) — initial schema, roles, and RLS policies.
-- Implements ADR-024 / ARCH-023 (roles §2, session GUC §3, policy templates §4,
-- per-table classification §6: TBL-023 delegation = OWN) for this service's
-- own dedicated Postgres database (ARCH-006 §5: one cluster per service).
-- Table shape from TBL-023 (delegation); ownership/lifecycle rules from SRV-010.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- 1. Roles (ARCH-023 §2)
-- ---------------------------------------------------------------------------
-- Idempotent guard so this migration can be re-run against a database where
-- the roles already exist. Login credentials (passwords / auth method) are
-- provisioned out of band by deployment tooling, not embedded in migration
-- source.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'delegation_app') THEN
    CREATE ROLE delegation_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'delegation_worker') THEN
    CREATE ROLE delegation_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO delegation_app, delegation_worker;

-- ---------------------------------------------------------------------------
-- 2. Session context helper (ARCH-023 §3)
-- ---------------------------------------------------------------------------
-- `delegation_app` connections `SET LOCAL app.citizen_id` (and reserved
-- `app.actor_role`) per transaction, resolved from the citizen's authenticated
-- session — never trusted from a request body. `delegation_worker` never sets
-- these; its policies (§4.3) don't key off them.

CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------
-- TBL-023 delegation. No enum-shaped columns are documented for this table.
--
-- relations (TBL-023 front matter): delegator_id -> TBL-001 citizen,
-- delegate_id -> TBL-001 citizen (both identity-service), domain_id ->
-- TBL-011 expert_domain (competency-service). None of these targets is owned
-- by delegation-service itself, so per ARCH-023 §5 / ADR-015 none is enforced
-- as a real FK here — each is an intentionally-unenforced cross-service
-- reference, checked by the calling handler over HTTP before the write
-- reaches this database (competency-service lookup per SRV-010 "Key rules":
-- "A citizen may delegate in a domain_id only to a citizen with active
-- competency in that domain").

CREATE TABLE delegation (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  delegator_id  uuid        NOT NULL, -- cross-service ref: identity-service citizen.id (TBL-001), not FK-enforced (ADR-015)
  delegate_id   uuid        NOT NULL, -- cross-service ref: identity-service citizen.id (TBL-001), not FK-enforced (ADR-015)
  domain_id     uuid        NOT NULL, -- cross-service ref: competency-service expert_domain.id (TBL-011), not FK-enforced (ADR-015)
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,

  -- Temporal invariants implied by "auto-expiring" / "revocable" (SRV-010 Key rules, TBL-023 Notes):
  -- expiry can never precede the delegation's own start, and a revocation can never be recorded
  -- as happening before the delegation existed.
  CONSTRAINT delegation_expires_after_created CHECK (expires_at > created_at),
  CONSTRAINT delegation_revoked_after_created CHECK (revoked_at IS NULL OR revoked_at >= created_at),

  -- Judgment call: not explicitly stated in TBL-023's Notes, but a citizen delegating to themselves
  -- is a structurally nonsensical row for a delegation-chain model (SRV-010 DP-041 walks
  -- delegator -> delegate -> further delegate; a self-loop is degenerate, not a valid 1-hop chain).
  -- Cheap, always-correct structural guard to add alongside the documented temporal invariants.
  CONSTRAINT delegation_not_self CHECK (delegator_id <> delegate_id)
);

-- Judgment call: TBL-023's Notes don't spell this out explicitly, but SRV-010's Key rules describe
-- domain-scoped delegation feeding a single chain-resolution walk (DP-041) with cycle rejection at
-- creation (DP-014) — which only holds together if a delegator has at most one *active* delegate per
-- domain at a time. Enforced as a partial unique index on (delegator_id, domain_id) WHERE revoked_at
-- IS NULL. Postgres partial-index predicates can't call volatile functions, so this can't also filter
-- on `expires_at > now()`; the remaining gap (a delegation that has expired but whose revoked_at hasn't
-- been set yet) is closed daily by DP-045's expiry cron, not by this index.
CREATE UNIQUE INDEX delegation_one_active_per_delegator_domain
  ON delegation (delegator_id, domain_id) WHERE revoked_at IS NULL;

ALTER TABLE delegation ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegation FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 4. Policies
-- ---------------------------------------------------------------------------
-- Corrected per SRV-010 Key rules/FR-056 ("delegator, delegate, domain, and
-- period are readable by any citizen") — ARCH-023 §6 originally classified
-- this table as plain OWN; that was a drafting error in the classification
-- table (fixed alongside this migration), not a real conflict to leave open.
-- Delegation is PUBLIC read + OWN write, the same shape as TBL-008 proposal:
-- any citizen may read any delegation row; only the delegator may create or
-- revoke (update) their own.

CREATE POLICY delegation_public_select ON delegation FOR SELECT TO delegation_app
  USING (true);
CREATE POLICY delegation_own_insert ON delegation FOR INSERT TO delegation_app
  WITH CHECK (delegator_id = current_citizen_id());
CREATE POLICY delegation_own_update ON delegation FOR UPDATE TO delegation_app
  USING (delegator_id = current_citizen_id()) WITH CHECK (delegator_id = current_citizen_id());

-- Blanket worker policy (ARCH-023 §4.3) — backs DP-041 (chain resolution on ballot cast),
-- DP-045 (daily expiry cron setting revoked_at), and any peer-service read of this table.
CREATE POLICY delegation_worker_all ON delegation FOR ALL TO delegation_worker
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------
-- Neither role is ever granted DELETE (ARCH-023 §2) — revocation/expiry are
-- UPDATEs (revoked_at), never row deletion; delegation is not append-only.

GRANT SELECT, INSERT, UPDATE ON delegation TO delegation_app;
GRANT SELECT, INSERT, UPDATE ON delegation TO delegation_worker;
