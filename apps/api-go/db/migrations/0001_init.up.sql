-- 0001_init for api-go (ADR-027, ADR-028): all tables owned by the four Go
-- services in ONE database — TBL-019…023 (voting, delegation), TBL-034…036
-- (audit), TBL-037…039 (auth) — plus the ARCH-023 role/RLS layer (ADR-024).
--
-- One database per app (ADR-028), not per service: the four services share
-- the api-go database the way ADR-015 gave each service its own. Consequences
-- of the merge, applied throughout this file:
--   * Roles are api_app / api_worker (ARCH-023 §2 slugs collapse to the app).
--   * Intra-app references are REAL foreign keys (vote_option,
--     eligibility_token, ballot → vote_session; constitutional_review →
--     constitutional_right). Cross-app references (proposal_id→TBL-008,
--     citizen_id→TBL-001, domain_id→TBL-011, jurisdiction_id→TBL-003) stay
--     documented comments, never FKs (ADR-015 boundary, ARCH-023 §5).
--   * RLS predicates are unchanged from the per-service classification
--     (ARCH-023 §6); only the role names changed.
--   * audit_log keeps seq + the §4.4 chain trigger (prev_hash = previous
--     payload_hash or GENESIS — identical to the in-memory store's rule).
--   * ballot keeps SPECIAL + APPEND_ONLY (no citizen_id, ever).
--
-- Tables first, policies after. Tool-agnostic numbered SQL (ARCH-023
-- §Overview). The service runs in-memory until DATABASE_URL is set
-- (ADR-029); this migration is what it runs on first connect.

-- ---------------------------------------------------------------- roles ---
-- Idempotent (the only rerunnable statements here): role creation has no
-- IF NOT EXISTS in Postgres, so it is guarded. Everything below runs once,
-- tracked by schema_migrations (internal/pg).

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'api_app') THEN
    CREATE ROLE api_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'api_worker') THEN
    CREATE ROLE api_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;

-- --------------------------------------------------------------- tables ---

-- Voting (SRV-008) ---

CREATE TABLE IF NOT EXISTS vote_session (
  id UUID PRIMARY KEY,
  proposal_id UUID NOT NULL,      -- TBL-008 proposal (cross-app, no FK)
  jurisdiction_id UUID NOT NULL,  -- TBL-003 jurisdiction (cross-app, no FK)
  method TEXT NOT NULL CHECK (method IN ('ranked_choice','approval','preference_score','comparative')),
  threshold_rule TEXT NOT NULL CHECK (threshold_rule IN ('simple_majority','majority_plus_quorum','supermajority')),
  min_participation NUMERIC NOT NULL DEFAULT 0 CHECK (min_participation >= 0 AND min_participation <= 1),
  cooling_off_until TIMESTAMPTZ NOT NULL,
  opens_at TIMESTAMPTZ NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','open','closed','certified')),
  tally_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (closes_at > opens_at)
);

CREATE TABLE IF NOT EXISTS vote_option (
  id UUID PRIMARY KEY,
  vote_session_id UUID NOT NULL REFERENCES vote_session(id) ON DELETE CASCADE,
  proposal_id UUID NOT NULL,  -- TBL-008 proposal (cross-app, no FK)
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS eligibility_token (
  id UUID PRIMARY KEY,
  vote_session_id UUID NOT NULL REFERENCES vote_session(id) ON DELETE CASCADE,
  citizen_id UUID NOT NULL,  -- TBL-001 citizen (cross-app, no FK)
  blinded_token_hash TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (vote_session_id, citizen_id)
);

-- DELIBERATELY no citizen_id (NFR-001, ADR-002, ARCH-023 §4.5).
CREATE TABLE IF NOT EXISTS ballot (
  id UUID PRIMARY KEY,
  vote_session_id UUID NOT NULL REFERENCES vote_session(id) ON DELETE CASCADE,
  token_blind TEXT NOT NULL,
  encrypted_choice TEXT NOT NULL,
  verification_code TEXT NOT NULL UNIQUE,
  cast_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Delegation (SRV-010) ---

CREATE TABLE IF NOT EXISTS delegation (
  id UUID PRIMARY KEY,
  delegator_id UUID NOT NULL,  -- TBL-001 citizen (cross-app, no FK)
  delegate_id UUID NOT NULL,   -- TBL-001 citizen (cross-app, no FK)
  domain_id UUID NOT NULL,     -- TBL-011 expert_domain (cross-app, no FK)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,  -- mandatory: no permanent delegates (FR-057)
  revoked_at TIMESTAMPTZ,
  CHECK (delegator_id <> delegate_id),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

-- Audit (SRV-012) ---

CREATE TABLE IF NOT EXISTS audit_log (
  seq BIGSERIAL NOT NULL,  -- internal ordering; not a TBL-034 field (§4.4)
  id UUID PRIMARY KEY,
  action_type TEXT NOT NULL CHECK (action_type IN ('proposal_created','proposal_status_changed','vote_certified','system_update','rule_change','admin_action','identity_event')),
  actor_ref TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,  -- DP-036 at-least-once dedupe (ADR-023)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS constitutional_right (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  protected BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS constitutional_review (
  id UUID PRIMARY KEY,
  proposal_id UUID NOT NULL,  -- TBL-008 proposal (cross-app, no FK)
  right_id UUID NOT NULL REFERENCES constitutional_right(id),
  result TEXT NOT NULL CHECK (result IN ('cleared','blocked')),
  reviewer_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Protocol change gate state (DP-043, SRV-012). Operational record for the
-- delayed-execution gate: approval refs point at TBL-033 approval rows
-- (governance-role-service, cross-app — opaque refs, never FKs). Not in the
-- tbl-NNN catalog: it tracks gate workflow state, not governance domain data.
CREATE TABLE IF NOT EXISTS protocol_change (
  id UUID PRIMARY KEY,
  change_ref TEXT NOT NULL,
  required_approval_refs TEXT[] NOT NULL,
  approvals JSONB NOT NULL DEFAULT '[]',
  delay_until TIMESTAMPTZ NOT NULL,
  visible_since TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);

-- Auth (SRV-017) ---

CREATE TABLE IF NOT EXISTS session (
  id UUID PRIMARY KEY,
  citizen_id UUID NOT NULL,  -- TBL-001 citizen (cross-app, no FK)
  access_token_hash TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL,
  -- Realizes the 15-minute access TTL (SRV-017 key rules; TBL-037 tracks the
  -- refresh deadline in expires_at, the access deadline lives here).
  access_expires_at TIMESTAMPTZ NOT NULL,
  device_fingerprint TEXT NOT NULL,
  ip_subnet TEXT NOT NULL,
  assurance_tier TEXT NOT NULL CHECK (assurance_tier IN ('T1','T2','T3')),
  last_mfa_at TIMESTAMPTZ,
  last_refresh_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mfa_factor (
  id UUID PRIMARY KEY,
  citizen_id UUID NOT NULL,  -- TBL-001 citizen (cross-app, no FK)
  factor_type TEXT NOT NULL CHECK (factor_type IN ('totp','passkey','facial')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  totp_secret_enc TEXT,
  passkey_credential_id TEXT,
  passkey_public_key TEXT,
  biometric_embedding_enc TEXT,  -- encrypted embedding only; raw image never stored
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_event (
  id UUID PRIMARY KEY,
  citizen_id UUID,   -- null for unauthenticated login attempts
  session_id UUID,   -- null before session creation
  event_type TEXT NOT NULL CHECK (event_type IN ('login_success','login_failure','mfa_success','mfa_failure','stepup_success','stepup_failure','anomaly_detected','session_revoked','factor_enrolled','factor_revoked')),
  factor_type TEXT CHECK (factor_type IN ('totp','passkey','facial')),
  ip_address TEXT,
  device_fingerprint TEXT,
  anomaly_reason TEXT CHECK (anomaly_reason IN ('new_device','new_country','concurrent_geos','mfa_brute_force','token_reuse')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------- session GUCs ---

CREATE OR REPLACE FUNCTION current_citizen_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.citizen_id', true), '')::uuid
$$;

-- ------------------------------------------------------------------ RLS ---

-- vote_session / vote_option: PUBLIC read, _worker-only write.
ALTER TABLE vote_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE vote_session FORCE ROW LEVEL SECURITY;
GRANT SELECT ON vote_session TO api_app, api_worker;
GRANT INSERT, UPDATE ON vote_session TO api_worker;
CREATE POLICY vote_session_public_read ON vote_session FOR SELECT TO api_app, api_worker USING (true);
CREATE POLICY vote_session_worker_all ON vote_session FOR ALL TO api_worker USING (true) WITH CHECK (true);

ALTER TABLE vote_option ENABLE ROW LEVEL SECURITY;
ALTER TABLE vote_option FORCE ROW LEVEL SECURITY;
GRANT SELECT ON vote_option TO api_app, api_worker;
GRANT INSERT, UPDATE ON vote_option TO api_worker;
CREATE POLICY vote_option_public_read ON vote_option FOR SELECT TO api_app, api_worker USING (true);
CREATE POLICY vote_option_worker_all ON vote_option FOR ALL TO api_worker USING (true) WITH CHECK (true);

-- eligibility_token: SPECIAL — OWN read, _worker-only write (the cast
-- handler flips used=true under _worker in one transaction with the ballot
-- insert: single-writer one-token-one-ballot).
ALTER TABLE eligibility_token ENABLE ROW LEVEL SECURITY;
ALTER TABLE eligibility_token FORCE ROW LEVEL SECURITY;
GRANT SELECT ON eligibility_token TO api_app, api_worker;
GRANT INSERT, UPDATE ON eligibility_token TO api_worker;
CREATE POLICY eligibility_token_own_read ON eligibility_token FOR SELECT TO api_app USING (citizen_id = current_citizen_id());
CREATE POLICY eligibility_token_worker_all ON eligibility_token FOR ALL TO api_worker USING (true) WITH CHECK (true);

-- ballot: SPECIAL + APPEND_ONLY — PUBLIC read, _worker-only insert, never
-- updated or deleted (REVOKE plus trigger).
ALTER TABLE ballot ENABLE ROW LEVEL SECURITY;
ALTER TABLE ballot FORCE ROW LEVEL SECURITY;
GRANT SELECT ON ballot TO api_app, api_worker;
GRANT INSERT ON ballot TO api_worker;
REVOKE UPDATE, DELETE ON ballot FROM api_app, api_worker;
CREATE POLICY ballot_public_read ON ballot FOR SELECT TO api_app, api_worker USING (true);
CREATE POLICY ballot_worker_insert ON ballot FOR INSERT TO api_worker WITH CHECK (true);

CREATE OR REPLACE FUNCTION ballot_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ballot is append-only: % not permitted', TG_OP;
END;
$$;
CREATE TRIGGER ballot_no_update BEFORE UPDATE ON ballot
  FOR EACH ROW EXECUTE FUNCTION ballot_forbid_mutation();
CREATE TRIGGER ballot_no_delete BEFORE DELETE ON ballot
  FOR EACH ROW EXECUTE FUNCTION ballot_forbid_mutation();

-- delegation: PUBLIC read (FR-056) + OWN write (delegator only).
ALTER TABLE delegation ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegation FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON delegation TO api_app, api_worker;
CREATE POLICY delegation_public_read ON delegation FOR SELECT TO api_app, api_worker USING (true);
CREATE POLICY delegation_own_write ON delegation FOR INSERT TO api_app WITH CHECK (delegator_id = current_citizen_id());
CREATE POLICY delegation_own_revoke ON delegation FOR UPDATE TO api_app USING (delegator_id = current_citizen_id()) WITH CHECK (delegator_id = current_citizen_id());
CREATE POLICY delegation_worker_all ON delegation FOR ALL TO api_worker USING (true) WITH CHECK (true);

-- audit_log: PUBLIC read (T1-public, FR-066) + _worker-only insert +
-- APPEND_ONLY + hash-chain trigger (§4.4).
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
GRANT SELECT ON audit_log TO api_app, api_worker;
GRANT INSERT ON audit_log TO api_worker;
REVOKE UPDATE, DELETE ON audit_log FROM api_app, api_worker;
CREATE POLICY audit_log_public_read ON audit_log FOR SELECT TO api_app, api_worker USING (true);
CREATE POLICY audit_log_worker_insert ON audit_log FOR INSERT TO api_worker WITH CHECK (true);

CREATE OR REPLACE FUNCTION audit_log_enforce_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tip_payload TEXT;
BEGIN
  SELECT payload_hash INTO tip_payload FROM audit_log ORDER BY seq DESC LIMIT 1;
  IF tip_payload IS NULL THEN
    IF NEW.prev_hash <> 'GENESIS' THEN
      RAISE EXCEPTION 'audit_log: first row must chain off GENESIS';
    END IF;
  ELSIF NEW.prev_hash <> tip_payload THEN
    RAISE EXCEPTION 'audit_log: prev_hash does not match chain tip';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_enforce_chain();

CREATE OR REPLACE FUNCTION audit_log_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % not permitted', TG_OP;
END;
$$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_mutation();
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_mutation();

-- constitutional_right: PUBLIC read, _worker-only write.
ALTER TABLE constitutional_right ENABLE ROW LEVEL SECURITY;
ALTER TABLE constitutional_right FORCE ROW LEVEL SECURITY;
GRANT SELECT ON constitutional_right TO api_app, api_worker;
GRANT INSERT, UPDATE ON constitutional_right TO api_worker;
CREATE POLICY constitutional_right_public_read ON constitutional_right FOR SELECT TO api_app, api_worker USING (true);
CREATE POLICY constitutional_right_worker_all ON constitutional_right FOR ALL TO api_worker USING (true) WITH CHECK (true);

-- constitutional_review: PUBLIC read, _worker-only write (reviewing role is
-- cross-app, resolved over HTTP before the _worker write — ARCH-023 §5).
ALTER TABLE constitutional_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE constitutional_review FORCE ROW LEVEL SECURITY;
GRANT SELECT ON constitutional_review TO api_app, api_worker;
GRANT INSERT, UPDATE ON constitutional_review TO api_worker;
CREATE POLICY constitutional_review_public_read ON constitutional_review FOR SELECT TO api_app, api_worker USING (true);
CREATE POLICY constitutional_review_worker_all ON constitutional_review FOR ALL TO api_worker USING (true) WITH CHECK (true);

-- protocol_change: PUBLIC read (DP-043 requires the change to be publicly
-- visible through the delay window), _worker-only write.
ALTER TABLE protocol_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE protocol_change FORCE ROW LEVEL SECURITY;
GRANT SELECT ON protocol_change TO api_app, api_worker;
GRANT INSERT, UPDATE ON protocol_change TO api_worker;
CREATE POLICY protocol_change_public_read ON protocol_change FOR SELECT TO api_app, api_worker USING (true);
CREATE POLICY protocol_change_worker_all ON protocol_change FOR ALL TO api_worker USING (true) WITH CHECK (true);

-- session / mfa_factor: OWN. auth_event: OWN read + _worker insert.
ALTER TABLE session ENABLE ROW LEVEL SECURITY;
ALTER TABLE session FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON session TO api_app, api_worker;
CREATE POLICY session_own_all ON session FOR ALL TO api_app USING (citizen_id = current_citizen_id()) WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY session_worker_all ON session FOR ALL TO api_worker USING (true) WITH CHECK (true);

ALTER TABLE mfa_factor ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_factor FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON mfa_factor TO api_app, api_worker;
CREATE POLICY mfa_factor_own_all ON mfa_factor FOR ALL TO api_app USING (citizen_id = current_citizen_id()) WITH CHECK (citizen_id = current_citizen_id());
CREATE POLICY mfa_factor_worker_all ON mfa_factor FOR ALL TO api_worker USING (true) WITH CHECK (true);

ALTER TABLE auth_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_event FORCE ROW LEVEL SECURITY;
GRANT SELECT ON auth_event TO api_app, api_worker;
GRANT INSERT ON auth_event TO api_worker;
CREATE POLICY auth_event_own_read ON auth_event FOR SELECT TO api_app USING (citizen_id = current_citizen_id());
CREATE POLICY auth_event_worker_all ON auth_event FOR ALL TO api_worker USING (true) WITH CHECK (true);
