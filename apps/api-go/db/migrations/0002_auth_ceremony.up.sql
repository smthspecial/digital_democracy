-- Operational WebAuthn state; challenge/grant secrets never stored in plaintext.
CREATE TABLE auth_ceremony (
  token_hash TEXT PRIMARY KEY,
  citizen_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('enrollment','registration','login')),
  payload JSONB NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX auth_ceremony_expiry_idx ON auth_ceremony(expires_at);
ALTER TABLE auth_ceremony ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_ceremony FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON auth_ceremony TO api_worker;
CREATE POLICY auth_ceremony_worker ON auth_ceremony FOR ALL TO api_worker USING (true) WITH CHECK (true);
-- Credential JSON includes public key, flags and authenticator counter.
ALTER TABLE mfa_factor ADD COLUMN webauthn_credential JSONB;
CREATE UNIQUE INDEX mfa_factor_passkey_credential_uidx ON mfa_factor(passkey_credential_id) WHERE factor_type = 'passkey';
CREATE UNIQUE INDEX mfa_factor_first_passkey_uidx ON mfa_factor(citizen_id) WHERE factor_type = 'passkey' AND status = 'active';
