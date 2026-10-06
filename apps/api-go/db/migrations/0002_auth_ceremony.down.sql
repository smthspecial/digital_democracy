DROP INDEX mfa_factor_passkey_credential_uidx;
DROP INDEX mfa_factor_first_passkey_uidx;
ALTER TABLE mfa_factor DROP COLUMN webauthn_credential;
DROP TABLE auth_ceremony;
