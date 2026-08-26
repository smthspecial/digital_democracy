package main

import (
	"net/http"
	"time"
)

type AssuranceTier string

const (
	TierT1 AssuranceTier = "T1"
	TierT2 AssuranceTier = "T2"
	TierT3 AssuranceTier = "T3"
)

type SessionStatus string

const (
	SessionActive    SessionStatus = "active"
	SessionSuspended SessionStatus = "suspended"
	SessionRevoked   SessionStatus = "revoked"
)

type FactorType string

const (
	FactorTOTP    FactorType = "totp"
	FactorPasskey FactorType = "passkey"
	FactorFacial  FactorType = "facial"
)

type FactorStatus string

const (
	FactorActive  FactorStatus = "active"
	FactorRevoked FactorStatus = "revoked"
)

type EventType string

const (
	EventLoginSuccess    EventType = "login_success"
	EventLoginFailure    EventType = "login_failure"
	EventMFASuccess      EventType = "mfa_success"
	EventMFAFailure      EventType = "mfa_failure"
	EventStepupSuccess   EventType = "stepup_success"
	EventStepupFailure   EventType = "stepup_failure"
	EventAnomalyDetected EventType = "anomaly_detected"
	EventSessionRevoked  EventType = "session_revoked"
	EventFactorEnrolled  EventType = "factor_enrolled"
	EventFactorRevoked   EventType = "factor_revoked"
)

// Citizen status values as reported by identity-service (SRV-001). auth-service
// trusts these as explicit request input for now since there is no live
// identity-service integration wired up in this phase (see handlers.go).
const (
	CitizenActive    = "active"
	CitizenPending   = "pending"
	CitizenSuspended = "suspended"
	CitizenRevoked   = "revoked"
)

// Session mirrors TBL-037. AccessToken/RefreshToken are transient: populated
// only on the response returned from issuance or rotation, never persisted —
// the store only ever keeps the hashes below.
type Session struct {
	AccessToken  string `json:"access_token,omitempty"`
	RefreshToken string `json:"refresh_token,omitempty"`

	ID                string        `json:"id"`
	CitizenID         string        `json:"citizen_id"`
	AccessTokenHash   string        `json:"-"`
	RefreshTokenHash  string        `json:"-"`
	DeviceFingerprint string        `json:"device_fingerprint"`
	IPSubnet          string        `json:"ip_subnet"`
	AssuranceTier     AssuranceTier `json:"assurance_tier"`
	LastMFAAt         time.Time     `json:"last_mfa_at,omitempty"`
	LastRefreshAt     time.Time     `json:"last_refresh_at,omitempty"`
	ExpiresAt         time.Time     `json:"expires_at"`
	Status            SessionStatus `json:"status"`
	CreatedAt         time.Time     `json:"created_at"`
}

// MFAFactor mirrors TBL-038.
type MFAFactor struct {
	ID                    string       `json:"id"`
	CitizenID             string       `json:"citizen_id"`
	FactorType            FactorType   `json:"factor_type"`
	Status                FactorStatus `json:"status"`
	TOTPSecretEnc         []byte       `json:"-"`
	PasskeyCredentialID   string       `json:"passkey_credential_id,omitempty"`
	PasskeyPublicKey      []byte       `json:"-"`
	BiometricEmbeddingEnc []byte       `json:"-"`
	EnrolledAt            time.Time    `json:"enrolled_at"`
	LastUsedAt            time.Time    `json:"last_used_at,omitempty"`
	RevokedAt             *time.Time   `json:"revoked_at,omitempty"`
}

// AuthEvent mirrors TBL-039. Immutable after creation (append-only).
type AuthEvent struct {
	ID                string     `json:"id"`
	CitizenID         string     `json:"citizen_id,omitempty"`
	SessionID         string     `json:"session_id,omitempty"`
	EventType         EventType  `json:"event_type"`
	FactorType        FactorType `json:"factor_type,omitempty"`
	IPAddress         string     `json:"ip_address,omitempty"`
	DeviceFingerprint string     `json:"device_fingerprint,omitempty"`
	AnomalyReason     string     `json:"anomaly_reason,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
}

// EnrollmentData carries the factor-specific payload for EnrollFactor. There is
// no separate "begin enrollment" round trip in this phase (e.g. no endpoint
// hands back a server-generated TOTP secret or passkey challenge first), so the
// caller supplies the proof material for the whole enrollment in one request,
// mirroring the same trust-the-caller simplification used by Login.
type EnrollmentData struct {
	TOTPSecret string
	TOTPCode   string

	PasskeyCredentialID string
	PasskeyPublicKeyDER []byte
	PasskeyChallenge    []byte
	PasskeySignature    []byte

	Embedding          []float64
	ReferenceEmbedding []float64
	Liveness           bool
}

// StepUpProof carries the factor-specific proof for CompleteStepUp.
type StepUpProof struct {
	TOTPCode string

	PasskeyChallenge []byte
	PasskeySignature []byte

	Embedding []float64
	Liveness  bool
}

type errKind int

const (
	kindValidation errKind = iota
	kindUnauthorized
	kindForbidden
	kindNotFound
	kindConflict
)

type domainError struct {
	kind errKind
	msg  string
}

func (e *domainError) Error() string { return e.msg }

func newDomainError(kind errKind, msg string) *domainError {
	return &domainError{kind: kind, msg: msg}
}

func errValidation(msg string) *domainError { return newDomainError(kindValidation, msg) }

var (
	errInvalidCredentials           = newDomainError(kindUnauthorized, "invalid credentials")
	errAuthenticationFailed         = newDomainError(kindUnauthorized, "authentication failed")
	errIdentityVerificationRequired = newDomainError(kindForbidden, "complete identity verification")
	errSessionNotFound              = newDomainError(kindNotFound, "session not found")
	errSessionRevoked               = newDomainError(kindForbidden, "session is revoked")
	errFactorNotEnrolled            = newDomainError(kindForbidden, "no active factor of that type enrolled")
	errInvalidProof                 = newDomainError(kindUnauthorized, "invalid proof")
	errTokenInvalid                 = newDomainError(kindUnauthorized, "invalid or expired token")
)

// statusForErr translates a domain error into its HTTP status code. Anything
// that isn't a *domainError is treated as an unexpected internal failure.
func statusForErr(err error) int {
	de, ok := err.(*domainError)
	if !ok {
		return http.StatusInternalServerError
	}
	switch de.kind {
	case kindValidation:
		return http.StatusBadRequest
	case kindUnauthorized:
		return http.StatusUnauthorized
	case kindForbidden:
		return http.StatusForbidden
	case kindNotFound:
		return http.StatusNotFound
	case kindConflict:
		return http.StatusConflict
	default:
		return http.StatusInternalServerError
	}
}
