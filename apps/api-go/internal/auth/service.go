package auth

import (
	"encoding/json"
	"time"

	"github.com/digital-democracy/api-go/internal/metrics"
)

// IdentityChecker reads citizen.status before any session is issued
// (SRV-017 dependency on identity-service). Missing configuration and unknown
// citizens fail closed. Tests provide their own identity checker.
type IdentityChecker interface {
	// StatusOf returns active|pending|suspended|revoked.
	StatusOf(citizenID string) (string, error)
}

type unavailableIdentityChecker struct{}

func (unavailableIdentityChecker) StatusOf(string) (string, error) { return "", ErrUnauthorized }

// AuditEmitter emits auth events to audit.append (DP-036) as identity_event
// entries. No-op by default; NATS/HTTP when wired.
type AuditEmitter interface {
	Emit(actionType, actorRef, payload string) error
}

type noopAuditEmitter struct{}

func (noopAuditEmitter) Emit(string, string, string) error { return nil }

// Notifier alerts citizens on anomaly or forced revocation (DP-039).
type Notifier interface {
	Notify(kind, recipientRef, message string) error
}

type noopNotifier struct{}

func (noopNotifier) Notify(string, string, string) error { return nil }

// Store is the persistence contract behind Service. MemoryStore serves tests
// and DATABASE_URL-less runs; PGStore (pgstore.go) serves Postgres via the
// sqlc-generated queries (ADR-029). Refresh-reuse and MFA-failure windows
// stay in process memory on both backends (best-effort across restarts).
type Store interface {
	InsertPasskey(factor *MfaFactor, credential json.RawMessage) (*MfaFactor, error)
	InsertCeremony(hash string, c Ceremony) error
	ConsumeCeremony(hash, kind string, now time.Time) (*Ceremony, error)
	SaveWebAuthnCredential(factorID string, credential, previous json.RawMessage) error
	WebAuthnCredential(factorID string) (json.RawMessage, error)
	InsertSession(s *Session) (*Session, error)
	GetSession(id string) (*Session, error)
	FindByAccess(hash string) (*Session, error)
	FindByRefresh(hash string) (*Session, error)
	RefreshReuse(hash string) bool
	RotateRefresh(id, newAccessHash, newRefreshHash string, accessExp, refreshedAt time.Time) (*Session, error)
	RotateAccess(id, newAccessHash string, accessExp time.Time) (*Session, error)
	SetStatus(id, status string) (*Session, error)
	SetTier(id, tier string, mfaAt time.Time) (*Session, error)
	RevokeAll(citizenID string, now time.Time) (int, error)
	SessionsOf(citizenID string) ([]*Session, error)
	PurgeExpired(now time.Time) (int, error)
	InsertFactor(f *MfaFactor) (*MfaFactor, error)
	ActiveFactors(citizenID string) ([]*MfaFactor, error)
	TouchFactor(id string, now time.Time) error
	AppendEvent(e *AuthEvent) (*AuthEvent, error)
	ListEvents(citizenID string) ([]*AuthEvent, error)
	RecordMFAFailure(sessionID string, now time.Time) bool
}

// Service implements DP-059, DP-060, DP-061, DP-066, DP-067.
type Service struct {
	store    Store
	identity IdentityChecker
	audit    AuditEmitter
	notifier Notifier
}

func NewService(store Store, identity IdentityChecker, audit AuditEmitter, notifier Notifier) *Service {
	if store == nil {
		store = NewStore()
	}
	if identity == nil {
		identity = unavailableIdentityChecker{}
	}
	if audit == nil {
		audit = noopAuditEmitter{}
	}
	if notifier == nil {
		notifier = noopNotifier{}
	}
	return &Service{store: store, identity: identity, audit: audit, notifier: notifier}
}

// Tokens is the one-time plaintext pair returned at login/refresh/step-up.
// RefreshToken travels as httpOnly cookie only — never logged, never stored.
type Tokens struct {
	AccessToken     string    `json:"access_token"`
	RefreshToken    string    `json:"refresh_token,omitempty"`
	AssuranceTier   string    `json:"assurance_tier"`
	AccessExpiresAt time.Time `json:"access_expires_at"`
	SessionID       string    `json:"session_id"`
}

type sessionInput struct {
	CitizenID         string
	DeviceFingerprint string
	IP                string
	IPSubnet          string
}

// issueSession is called only after the HTTP WebAuthn verifier proves key possession.
func (s *Service) issueSession(in sessionInput, now time.Time) (*Session, *Tokens, error) {
	if in.CitizenID == "" || in.DeviceFingerprint == "" {
		return nil, nil, ErrInvalid
	}
	status, err := s.identity.StatusOf(in.CitizenID)
	if err != nil {
		s.recordEvent("", "", EventLoginFailure, "", in.IP, in.DeviceFingerprint, "")
		return nil, nil, ErrUnauthorized
	}
	switch status {
	case "suspended", "revoked", "inactive":
		// No detail leak: identical response to unknown credentials.
		s.recordEvent(in.CitizenID, "", EventLoginFailure, "", in.IP, in.DeviceFingerprint, "")
		_ = s.audit.Emit("identity_event", "auth-service", "login_rejected:"+in.CitizenID)
		return nil, nil, ErrUnauthorized
	case "pending":
		s.recordEvent(in.CitizenID, "", EventLoginFailure, "", in.IP, in.DeviceFingerprint, "")
		return nil, nil, ErrForbidden
	case "active":
	default:
		return nil, nil, ErrUnauthorized
	}

	tier := TierT1
	lastMFA := time.Time{}

	access := newToken()
	refresh := newToken()
	sess := &Session{
		ID:                newID(),
		CitizenID:         in.CitizenID,
		AccessTokenHash:   sha256Hex(access),
		RefreshTokenHash:  sha256Hex(refresh),
		AccessExpiresAt:   now.Add(AccessTokenTTL),
		DeviceFingerprint: in.DeviceFingerprint,
		IPSubnet:          in.IPSubnet,
		AssuranceTier:     tier,
		LastMFAAt:         lastMFA,
		LastRefreshAt:     now,
		ExpiresAt:         now.Add(RefreshTTL),
		Status:            SessionActive,
		CreatedAt:         now,
	}
	// Stores persist the session and return the stored row; services must use
	// the returned row, never the input (backends differ in ID assignment).
	stored, err := s.store.InsertSession(sess)
	if err != nil {
		return nil, nil, err
	}
	s.recordEvent(in.CitizenID, stored.ID, EventLoginSuccess, "", in.IP, in.DeviceFingerprint, "")
	_ = s.audit.Emit("identity_event", "auth-service", "login:"+in.CitizenID)
	out := *stored
	return &out, &Tokens{AccessToken: access, RefreshToken: refresh, AssuranceTier: tier, AccessExpiresAt: stored.AccessExpiresAt, SessionID: stored.ID}, nil
}

// Refresh runs the DP-059 token refresh flow: binding check → rotation →
// tier re-evaluation (downgrade to T1 past the 12h MFA window).
func (s *Service) Refresh(refreshToken, deviceFP, ipSubnet, ip string, now time.Time) (*Tokens, error) {
	if refreshToken == "" {
		return nil, ErrInvalid
	}
	hash := sha256Hex(refreshToken)
	sess, err := s.store.FindByRefresh(hash)
	if err != nil {
		if s.store.RefreshReuse(hash) {
			// Rotated token presented again: possible theft (DP-066).
			_ = s.audit.Emit("identity_event", "auth-service", "token_reuse")
		}
		return nil, ErrUnauthorized
	}
	if sess.Status != SessionActive || now.After(sess.ExpiresAt) {
		return nil, ErrUnauthorized
	}
	status, err := s.identity.StatusOf(sess.CitizenID)
	if err != nil || status != "active" {
		return nil, ErrUnauthorized
	}
	if sess.DeviceFingerprint != deviceFP || sess.IPSubnet != ipSubnet {
		s.suspendForAnomaly(sess, AnomalyNewDevice, ip, deviceFP, now)
		return nil, ErrUnauthorized
	}
	tier := sess.AssuranceTier
	if tier == TierT2 && now.Sub(sess.LastMFAAt) > T2ValidityWindow {
		tier = TierT1
	}
	if tier == TierT3 {
		// T3 never survives a refresh: high-stakes actions need a fresh
		// challenge within 5 minutes (DP-061 window).
		tier = TierT1
	}
	access := newToken()
	refresh := newToken()
	updated, err := s.store.RotateRefresh(sess.ID, sha256Hex(access), sha256Hex(refresh), now.Add(AccessTokenTTL), now)
	if err != nil {
		return nil, ErrUnauthorized
	}
	if tier != updated.AssuranceTier {
		updated, err = s.store.SetTier(sess.ID, tier, updated.LastMFAAt)
		if err != nil {
			return nil, err
		}
	}
	return &Tokens{AccessToken: access, RefreshToken: refresh, AssuranceTier: tier, AccessExpiresAt: updated.AccessExpiresAt, SessionID: sess.ID}, nil
}

// Logout runs the DP-059 logout flow: revoke + zero the refresh hash.
func (s *Service) Logout(accessToken string) error {
	if accessToken == "" {
		return ErrInvalid
	}
	sess, err := s.store.FindByAccess(sha256Hex(accessToken))
	if err != nil {
		return ErrNotFound
	}
	if _, err := s.store.SetStatus(sess.ID, SessionRevoked); err != nil {
		return err
	}
	s.recordEvent(sess.CitizenID, sess.ID, EventSessionRevoked, "", "", sess.DeviceFingerprint, "")
	_ = s.audit.Emit("identity_event", "auth-service", "logout:"+sess.CitizenID)
	return nil
}

// Validate is the internal endpoint all services call per request: TTL,
// status, and tier in one check.
func (s *Service) Validate(accessToken string, now time.Time) (*Session, error) {
	if accessToken == "" {
		return nil, ErrUnauthorized
	}
	sess, err := s.store.FindByAccess(sha256Hex(accessToken))
	if err != nil || sess.Status != SessionActive || now.After(sess.AccessExpiresAt) {
		return nil, ErrUnauthorized
	}
	status, err := s.identity.StatusOf(sess.CitizenID)
	if err != nil || status != "active" {
		return nil, ErrUnauthorized
	}
	if sess.AssuranceTier == TierT3 && now.Sub(sess.LastMFAAt) > T3ValidityWindow {
		sess.AssuranceTier = TierT1
	}
	if sess.AssuranceTier == TierT2 && now.Sub(sess.LastMFAAt) > T2ValidityWindow {
		sess.AssuranceTier = TierT1
	}
	return sess, nil
}

// suspendForAnomaly runs the DP-066 response flow: suspend, record, audit,
// notify. Restoration needs a fresh T3 step-up; unauthorized reports revoke.
func (s *Service) suspendForAnomaly(sess *Session, reason, ip, deviceFP string, now time.Time) {
	_ = now
	// Best-effort: callers already return errors, so a failed suspension
	// surfaces through them on the next check; nothing here may panic.
	_, _ = s.store.SetStatus(sess.ID, SessionSuspended)
	s.recordEvent(sess.CitizenID, sess.ID, EventAnomaly, "", ip, deviceFP, reason)
	_ = s.audit.Emit("identity_event", "auth-service", "anomaly:"+reason+":"+sess.CitizenID)
	_ = s.notifier.Notify("anomaly", sess.CitizenID, "anomaly detected: "+reason)
}

// RevokeAll exposes the internal revoke_all_sessions endpoint for
// identity-service (DP-042 linkage): multi-approval decisions only.
func (s *Service) RevokeAll(citizenID string, now time.Time) (int, error) {
	if citizenID == "" {
		return 0, ErrInvalid
	}
	n, err := s.store.RevokeAll(citizenID, now)
	if err != nil {
		return 0, err
	}
	s.recordEvent(citizenID, "", EventSessionRevoked, "", "", "", "")
	_ = s.audit.Emit("identity_event", "auth-service", "revoke_all:"+citizenID)
	_ = s.notifier.Notify("forced_revocation", citizenID, "sessions revoked by governance decision")
	return n, nil
}

// Purge runs DP-067.
func (s *Service) Purge(now time.Time) (int, error) { return s.store.PurgeExpired(now) }

func (s *Service) recordEvent(citizenID, sessionID, eventType, factorType, ip, deviceFP, anomaly string) {
	// Best-effort telemetry: event loss on total backend failure must never
	// fail the authentication flow it describes.
	_, _ = s.store.AppendEvent(&AuthEvent{
		CitizenID: citizenID, SessionID: sessionID, EventType: eventType,
		FactorType: factorType, IPAddress: ip, DeviceFingerprint: deviceFP, AnomalyReason: anomaly,
	})
	switch eventType {
	case EventLoginSuccess:
		metrics.AuthLoginAttemptsTotal.WithLabelValues("success").Inc()
	case EventLoginFailure:
		metrics.AuthLoginAttemptsTotal.WithLabelValues("rejected").Inc()
	case EventAnomaly:
		metrics.AuthAnomaliesTotal.Inc()
	}
}
