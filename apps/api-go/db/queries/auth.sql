-- Auth queries (TBL-037…039). Refresh rotation retires hashes into the
-- Go-side reuse set (best-effort replay detection); MFA failure windows are
-- tracked the same way. Both are documented in pgStore.

-- name: InsertSession :one
INSERT INTO session (id, citizen_id, access_token_hash, refresh_token_hash, access_expires_at, device_fingerprint, ip_subnet, assurance_tier, last_mfa_at, last_refresh_at, expires_at, status)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
RETURNING *;

-- name: GetSession :one
SELECT * FROM session WHERE id = $1;

-- name: FindSessionByAccessHash :one
SELECT * FROM session WHERE access_token_hash = $1;

-- name: FindSessionByRefreshHash :one
SELECT * FROM session WHERE refresh_token_hash = $1;

-- name: RotateSessionTokens :one
UPDATE session
SET access_token_hash = $2, refresh_token_hash = $3, access_expires_at = $4, last_refresh_at = $5
WHERE id = $1
RETURNING *;

-- name: RotateSessionAccess :one
UPDATE session
SET access_token_hash = $2, access_expires_at = $3
WHERE id = $1
RETURNING *;

-- name: SetSessionStatus :one
UPDATE session SET status = $2 WHERE id = $1
RETURNING *;

-- name: SetSessionTier :one
UPDATE session SET assurance_tier = $2, last_mfa_at = $3 WHERE id = $1
RETURNING *;

-- name: RevokeAllCitizenSessions :execrows
UPDATE session SET status = 'revoked' WHERE citizen_id = $1 AND status <> 'revoked';

-- name: SessionsOfCitizen :many
SELECT * FROM session WHERE citizen_id = $1 ORDER BY created_at, id;

-- name: PurgeExpiredSessions :execrows
DELETE FROM session WHERE status <> 'revoked' AND expires_at < $1;

-- name: InsertMfaFactor :one
INSERT INTO mfa_factor (id, citizen_id, factor_type, status, totp_secret_enc, passkey_credential_id, passkey_public_key, biometric_embedding_enc, last_used_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- name: ActiveFactorsOfCitizen :many
SELECT * FROM mfa_factor WHERE citizen_id = $1 AND status = 'active' ORDER BY enrolled_at, id;

-- name: TouchMfaFactor :exec
UPDATE mfa_factor SET last_used_at = $2 WHERE id = $1;

-- name: RevokeMfaFactor :one
UPDATE mfa_factor SET status = 'revoked', revoked_at = $3
WHERE id = $1 AND citizen_id = $2
RETURNING *;

-- name: InsertAuthEvent :one
INSERT INTO auth_event (id, citizen_id, session_id, event_type, factor_type, ip_address, device_fingerprint, anomaly_reason)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING *;

-- name: ListAuthEvents :many
SELECT * FROM auth_event ORDER BY created_at, id;

-- name: ListCitizenAuthEvents :many
SELECT * FROM auth_event WHERE citizen_id = $1 ORDER BY created_at, id;
