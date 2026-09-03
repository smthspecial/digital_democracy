-- SRV-017 auth-service — initial schema, roles, and RLS policies.
-- Implements ADR-024 / ARCH-023 for this service's own dedicated Postgres database.
-- Owned tables (per srv-017.md / ARCH-023 §6): TBL-037 session, TBL-038 mfa_factor,
-- TBL-039 auth_event.

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- 1. Roles (ARCH-023 §2) — idempotent, so re-running this migration against
--    a database that already has the roles is a no-op rather than an error.
--    Login credentials (passwords) are provisioned out-of-band by whatever
--    secrets pipeline wires this service to Postgres; not hard-coded here.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_app') THEN
    CREATE ROLE auth_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_worker') THEN
    CREATE ROLE auth_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- Lock down the default public grant, then open USAGE explicitly to the two
-- roles this service actually uses (ARCH-023 §2).
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO auth_app, auth_worker;

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

-- TBL-037 session.assurance_tier
CREATE TYPE session_assurance_tier AS ENUM ('T1', 'T2', 'T3');

-- TBL-037 session.status
CREATE TYPE session_status AS ENUM ('active', 'suspended', 'revoked');

-- TBL-038 mfa_factor.factor_type — also reused for TBL-039 auth_event.factor_type
-- below (same documented value set: totp | passkey | facial), so both columns
-- share one type rather than duplicating an identical enum under a second name.
CREATE TYPE mfa_factor_type AS ENUM ('totp', 'passkey', 'facial');

-- TBL-038 mfa_factor.status
CREATE TYPE mfa_factor_status AS ENUM ('active', 'revoked');

-- TBL-039 auth_event.event_type
CREATE TYPE auth_event_type AS ENUM (
  'login_success', 'login_failure', 'mfa_success', 'mfa_failure',
  'stepup_success', 'stepup_failure', 'anomaly_detected', 'session_revoked',
  'factor_enrolled', 'factor_revoked'
);

-- Note: tbl-039.md documents anomaly_reason's column *type* as `text` (not
-- `enum`), with a parenthetical list of expected values — so no CREATE TYPE
-- for it; the documented value set is instead enforced with a CHECK
-- constraint below, matching the type the doc actually specifies.

-- ---------------------------------------------------------------------------
-- 4. Tables
-- ---------------------------------------------------------------------------

-- TBL-037 session — implements ADR-014. relations: citizen_id -> TBL-001
-- citizen, owned by identity-service (a different service database).
CREATE TABLE session (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- citizen_id: cross-service ref to citizen(id) in identity-service's own
  -- DB. No FK per ADR-015 (no cross-database FKs) — intentionally unenforced.
  citizen_id          uuid NOT NULL,
  access_token_hash   text NOT NULL,
  refresh_token_hash  text NOT NULL,
  device_fingerprint  text NOT NULL,
  ip_subnet           text NOT NULL,
  -- Judgment call: DEFAULT 'T1' — a newly issued session starts at the base
  -- assurance tier before any step-up MFA has occurred; tbl-037.md doesn't
  -- name a default explicitly, but "current MFA assurance level" implies a
  -- starting value, and T1 is the lowest documented tier.
  assurance_tier      session_assurance_tier NOT NULL DEFAULT 'T1',
  last_mfa_at         timestamptz, -- nullable: no MFA has necessarily occurred yet
  last_refresh_at     timestamptz, -- nullable: not yet refreshed since creation
  expires_at          timestamptz NOT NULL,
  -- Judgment call: DEFAULT 'active' — the natural starting lifecycle state.
  status              session_status NOT NULL DEFAULT 'active',
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Judgment call: temporal invariant implied by "absolute session deadline" —
  -- a session cannot expire before (or at) the instant it was created.
  CONSTRAINT session_expires_after_created CHECK (expires_at > created_at)
);

-- TBL-038 mfa_factor — implements ADR-014. relations: citizen_id -> TBL-001
-- citizen, owned by identity-service (a different service database).
CREATE TABLE mfa_factor (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- citizen_id: cross-service ref to citizen(id) in identity-service's own
  -- DB. No FK per ADR-015 — intentionally unenforced.
  citizen_id                uuid NOT NULL,
  factor_type               mfa_factor_type NOT NULL,
  -- Judgment call: DEFAULT 'active' — a factor is usable immediately on
  -- enrollment.
  status                    mfa_factor_status NOT NULL DEFAULT 'active',
  totp_secret_enc           text, -- null for non-TOTP factors (tbl-038.md)
  passkey_credential_id     text, -- null for non-passkey factors (tbl-038.md)
  passkey_public_key        text, -- null for non-passkey factors (tbl-038.md)
  biometric_embedding_enc   text, -- null for non-facial factors (tbl-038.md)
  enrolled_at               timestamptz NOT NULL DEFAULT now(),
  last_used_at              timestamptz, -- nullable: may never have been used
  revoked_at                timestamptz, -- null if active (tbl-038.md)
  -- Judgment call: tbl-038.md documents each type-specific secret column as
  -- "null for non-<type> factors" — implemented here as a single CHECK
  -- tying the populated column to factor_type, rather than leaving it to
  -- application code alone.
  CONSTRAINT mfa_factor_type_fields_consistent CHECK (
    CASE factor_type
      WHEN 'totp' THEN
        totp_secret_enc IS NOT NULL
        AND passkey_credential_id IS NULL AND passkey_public_key IS NULL
        AND biometric_embedding_enc IS NULL
      WHEN 'passkey' THEN
        passkey_credential_id IS NOT NULL AND passkey_public_key IS NOT NULL
        AND totp_secret_enc IS NULL AND biometric_embedding_enc IS NULL
      WHEN 'facial' THEN
        biometric_embedding_enc IS NOT NULL
        AND totp_secret_enc IS NULL
        AND passkey_credential_id IS NULL AND passkey_public_key IS NULL
    END
  ),
  -- Judgment call: tbl-038.md's "revoked_at (null if active)" is a direct,
  -- literal invariant statement — enforced as a CHECK rather than trusting
  -- application code alone.
  CONSTRAINT mfa_factor_revoked_at_consistent CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

-- Judgment call: tbl-038.md's Notes read "A citizen may hold multiple factors
-- of different types" — the specific qualifier "of different types" implies
-- at most one *active* factor per type per citizen (this is also exactly the
-- "one-active-factor-per-type" invariant shape). Modeled as a partial unique
-- index (Postgres has no bare UNIQUE-with-WHERE constraint syntax) rather
-- than a table-level UNIQUE, since revoked factors of the same type must
-- remain (they're retained for audit, per the same Notes section).
CREATE UNIQUE INDEX mfa_factor_one_active_per_type
  ON mfa_factor (citizen_id, factor_type)
  WHERE status = 'active';

-- TBL-039 auth_event — implements ADR-014. relations: citizen_id -> TBL-001
-- citizen (identity-service, cross-service, unenforced); session_id ->
-- TBL-037 session (this same service — real FK).
CREATE TABLE auth_event (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- citizen_id: cross-service ref to citizen(id) in identity-service's own
  -- DB. No FK per ADR-015. Nullable: "null for unauthenticated login
  -- attempts" (tbl-039.md).
  citizen_id          uuid,
  -- session_id: same-service FK to session(id). Nullable: "null before
  -- session creation" (tbl-039.md, e.g. a login_failure event).
  session_id          uuid REFERENCES session (id) ON DELETE RESTRICT,
  event_type          auth_event_type NOT NULL,
  factor_type         mfa_factor_type, -- nullable per tbl-039.md ("... | null")
  ip_address          text NOT NULL,
  device_fingerprint  text NOT NULL,
  anomaly_reason      text, -- populated only on anomaly_detected events; see CHECK below
  created_at          timestamptz NOT NULL DEFAULT now(),
  -- Judgment call: tbl-039.md ties anomaly_reason's presence and value set
  -- to anomaly_detected events explicitly ("Populated on anomaly_detected
  -- events (new_device | new_country | concurrent_geos | mfa_brute_force |
  -- token_reuse)") — enforced as a CHECK since the column's documented type
  -- is `text`, not `enum`.
  CONSTRAINT auth_event_anomaly_reason_consistent CHECK (
    (event_type = 'anomaly_detected'
      AND anomaly_reason IN ('new_device', 'new_country', 'concurrent_geos', 'mfa_brute_force', 'token_reuse'))
    OR (event_type <> 'anomaly_detected' AND anomaly_reason IS NULL)
  )
);

-- ---------------------------------------------------------------------------
-- 5. Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE session ENABLE ROW LEVEL SECURITY;
ALTER TABLE session FORCE ROW LEVEL SECURITY;

ALTER TABLE mfa_factor ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_factor FORCE ROW LEVEL SECURITY;

ALTER TABLE auth_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_event FORCE ROW LEVEL SECURITY;

-- --- session: OWN (ARCH-023 §4.1 / §6: "TBL-037 session | OWN | citizen_id;
-- _app may INSERT/UPDATE own row (login/refresh resolves app.citizen_id from
-- credentials before the query, no bootstrap problem)").

CREATE POLICY session_own_select ON session FOR SELECT
  TO auth_app
  USING (citizen_id = current_citizen_id());

CREATE POLICY session_own_insert ON session FOR INSERT
  TO auth_app
  WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY session_own_update ON session FOR UPDATE
  TO auth_app
  USING (citizen_id = current_citizen_id())
  WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY session_worker_all ON session FOR ALL
  TO auth_worker
  USING (true) WITH CHECK (true);

-- --- mfa_factor: OWN (ARCH-023 §4.1 / §6: "TBL-038 mfa_factor (auth) | OWN
-- | citizen_id").

CREATE POLICY mfa_factor_own_select ON mfa_factor FOR SELECT
  TO auth_app
  USING (citizen_id = current_citizen_id());

CREATE POLICY mfa_factor_own_insert ON mfa_factor FOR INSERT
  TO auth_app
  WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY mfa_factor_own_update ON mfa_factor FOR UPDATE
  TO auth_app
  USING (citizen_id = current_citizen_id())
  WITH CHECK (citizen_id = current_citizen_id());

CREATE POLICY mfa_factor_worker_all ON mfa_factor FOR ALL
  TO auth_worker
  USING (true) WITH CHECK (true);

-- --- auth_event: OWN read + worker insert (ARCH-023 §6: "TBL-039 auth_event
-- (auth) | OWN read + worker insert | security log; not governance-public;
-- citizen_id"). No _app INSERT/UPDATE policy: this is a system-written
-- security log, not a citizen-authored record.

CREATE POLICY auth_event_own_select ON auth_event FOR SELECT
  TO auth_app
  USING (citizen_id = current_citizen_id());

CREATE POLICY auth_event_worker_all ON auth_event FOR ALL
  TO auth_worker
  USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 6. Grants (ARCH-023 §2: DELETE is never granted to either role in this
--    pass.)
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON session TO auth_app;
GRANT SELECT, INSERT, UPDATE ON session TO auth_worker;

GRANT SELECT, INSERT, UPDATE ON mfa_factor TO auth_app;
GRANT SELECT, INSERT, UPDATE ON mfa_factor TO auth_worker;

-- auth_event: _app is read-only (OWN read only, no insert/update policy
-- above); _worker gets SELECT + INSERT only — UPDATE is deliberately
-- withheld from both roles, see the append-only enforcement below.
GRANT SELECT ON auth_event TO auth_app;
GRANT SELECT, INSERT ON auth_event TO auth_worker;

-- ---------------------------------------------------------------------------
-- 7. Append-only enforcement — auth_event (ARCH-023 §4.4)
-- ---------------------------------------------------------------------------
-- Judgment call: auth_event is not in ARCH-023 §4.4's named APPEND_ONLY list
-- (audit_log, ballot, ledger_entry) and its §6 classification row doesn't
-- say APPEND_ONLY either — but tbl-039.md's own Notes state outright "Rows
-- are immutable after creation," which is exactly the condition §4.4's
-- opening sentence names ("any table where a row, once written, must never
-- change"). Applying the full §4.4 treatment here: REVOKE UPDATE/DELETE
-- (redundant with the grants above, which never included UPDATE, but kept
-- explicit per the template) plus the forbid-mutation trigger, which also
-- stops the table-owner/migrator role from mutating history by accident.

REVOKE UPDATE, DELETE ON auth_event FROM auth_app, auth_worker;

CREATE OR REPLACE FUNCTION auth_event_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'auth_event is append-only: % not permitted', TG_OP;
END;
$$;

CREATE TRIGGER auth_event_no_update BEFORE UPDATE ON auth_event
  FOR EACH ROW EXECUTE FUNCTION auth_event_forbid_mutation();
CREATE TRIGGER auth_event_no_delete BEFORE DELETE ON auth_event
  FOR EACH ROW EXECUTE FUNCTION auth_event_forbid_mutation();
