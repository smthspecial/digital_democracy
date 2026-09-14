// Package auth implements auth-service (SRV-017).
//
// Responsibility per .spec/technical/services/srv-017.md: the full
// authentication lifecycle — sessions, MFA enrollment/verification, step-up
// challenges, anomaly response (ADR-014, DP-059, DP-060, DP-061, DP-066,
// DP-067). Sole issuer of access tokens; every other service validates
// against GET /auth/validate. Authorization decisions live in each service
// (AUTH-010) — this service only asserts identity and assurance tier.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"
)

// Assurance tiers (ADR-014): T1 read, T2 standard write (MFA within 12h),
// T3 high-stakes write (fresh biometric/passkey within 5 minutes).
const (
	TierT1 = "T1"
	TierT2 = "T2"
	TierT3 = "T3"
)

// Session statuses (TBL-037.status). Revoked rows are retained for audit and
// can never be reactivated; only naturally-expired rows are purged (DP-067).
const (
	SessionActive    = "active"
	SessionSuspended = "suspended"
	SessionRevoked   = "revoked"
)

// MFA factor types and statuses (TBL-038).
const (
	FactorTOTP    = "totp"
	FactorPasskey = "passkey"
	FactorFacial  = "facial"

	FactorActive  = "active"
	FactorRevoked = "revoked"
)

// Auth event types (TBL-039.event_type).
const (
	EventLoginSuccess   = "login_success"
	EventLoginFailure   = "login_failure"
	EventMFASuccess     = "mfa_success"
	EventMFAFailure     = "mfa_failure"
	EventStepupSuccess  = "stepup_success"
	EventStepupFailure  = "stepup_failure"
	EventAnomaly        = "anomaly_detected"
	EventSessionRevoked = "session_revoked"
	EventFactorEnrolled = "factor_enrolled"
	EventFactorRevoked  = "factor_revoked"
)

// Anomaly reasons (DP-066).
const (
	AnomalyNewDevice      = "new_device"
	AnomalyNewCountry     = "new_country"
	AnomalyConcurrentGeos = "concurrent_geos"
	AnomalyMFAForce       = "mfa_brute_force"
	AnomalyTokenReuse     = "token_reuse"
)

// TTLs and windows (ADR-014, DP-059, DP-061).
const (
	AccessTokenTTL   = 15 * time.Minute
	T2ValidityWindow = 12 * time.Hour
	T3ValidityWindow = 5 * time.Minute
	RefreshTTL       = 30 * 24 * time.Hour
	PurgeGrace       = 24 * time.Hour
	MaxMFAFailures   = 5
	MFAFailureWindow = 10 * time.Minute
)

// Session is TBL-037. Only token hashes are stored; plaintext tokens are
// returned once at issuance/refresh and never persisted.
type Session struct {
	ID                string    `json:"id"`
	CitizenID         string    `json:"citizen_id"`
	AccessTokenHash   string    `json:"-"`
	RefreshTokenHash  string    `json:"-"`
	AccessExpiresAt   time.Time `json:"access_expires_at"`
	DeviceFingerprint string    `json:"device_fingerprint"`
	IPSubnet          string    `json:"ip_subnet"`
	AssuranceTier     string    `json:"assurance_tier"`
	LastMFAAt         time.Time `json:"last_mfa_at"`
	LastRefreshAt     time.Time `json:"last_refresh_at"`
	ExpiresAt         time.Time `json:"expires_at"`
	Status            string    `json:"status"`
	CreatedAt         time.Time `json:"created_at"`
}

// MfaFactor is TBL-038. Secrets/embeddings are stored encrypted-at-rest
// (opaque "enc:" envelope here; KMS envelope encryption in production). The
// biometric embedding never leaves this service (ADR-014).
type MfaFactor struct {
	ID                    string     `json:"id"`
	CitizenID             string     `json:"citizen_id"`
	FactorType            string     `json:"factor_type"`
	Status                string     `json:"status"`
	TOTPSecretEnc         string     `json:"-"`
	PasskeyCredentialID   string     `json:"passkey_credential_id,omitempty"`
	PasskeyPublicKey      string     `json:"-"`
	BiometricEmbeddingEnc string     `json:"-"`
	EnrolledAt            time.Time  `json:"enrolled_at"`
	LastUsedAt            time.Time  `json:"last_used_at"`
	RevokedAt             *time.Time `json:"revoked_at,omitempty"`
}

// AuthEvent is TBL-039. Immutable once written.
type AuthEvent struct {
	ID                string    `json:"id"`
	CitizenID         string    `json:"citizen_id,omitempty"`
	SessionID         string    `json:"session_id,omitempty"`
	EventType         string    `json:"event_type"`
	FactorType        string    `json:"factor_type,omitempty"`
	IPAddress         string    `json:"-"`
	DeviceFingerprint string    `json:"-"`
	AnomalyReason     string    `json:"anomaly_reason,omitempty"`
	CreatedAt         time.Time `json:"created_at"`
}

var (
	ErrNotFound       = errors.New("not found")
	ErrInvalid        = errors.New("invalid request")
	ErrUnauthorized   = errors.New("unauthorized")
	ErrForbidden      = errors.New("forbidden")
	ErrStepUpRequired = errors.New("step-up authentication required")
)

func validTier(t string) bool { return t == TierT1 || t == TierT2 || t == TierT3 }

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	// Dashed UUID format: matches the UUID columns in db/migrations.
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func newToken() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}
