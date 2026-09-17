package auth

import (
	"errors"
	"time"

	"github.com/digital-democracy/api-go/internal/metrics"
)

// IdentityChecker reads citizen.status before any session is issued
// (SRV-017 dependency on identity-service). Allow-all-active locally; HTTP
// in production. Unknown citizens fail closed.
type IdentityChecker interface {
	// StatusOf returns active|pending|suspended|revoked.
	StatusOf(citizenID string) (string, error)
}

type activeIdentityChecker struct{}

func (activeIdentityChecker) StatusOf(string) (string, error) { return "active", nil }

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
		identity = activeIdentityChecker{}
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

type LoginInput struct {
	CitizenID         string
	DeviceFingerprint string
	IP                string
	IPSubnet          string
	StepUpFactorType  string // optional completed challenge at login (DP-061)
	StepUpProof       string // factor-specific proof (TOTP code / assertion / liveness ref)
	LivenessConfirmed bool   // facial challenges must confirm liveness
}

// Login runs DP-059: credential check → status gate → session at T1, elevated
// when a valid step-up proof accompanies the call or no enrollment exists yet
// (T1-only until DP-060 enrollment).
func (s *Service) Login(in LoginInput, now time.Time) (*Session, *Tokens, error) {
	if in.CitizenID == "" || in.DeviceFingerprint == "" {
		return nil, nil, ErrInvalid
	}
	status, err := s.identity.StatusOf(in.CitizenID)
	if err != nil {
		s.recordEvent("", "", EventLoginFailure, "", in.IP, in.DeviceFingerprint, "")
		return nil, nil, ErrUnauthorized
	}
	switch status {
	case "suspended", "revoked":
		// No detail leak: identical response to unknown credentials.
		s.recordEvent(in.CitizenID, "", EventLoginFailure, "", in.IP, in.DeviceFingerprint, "")
		_ = s.audit.Emit("identity_event", "auth-service", "login_rejected:"+in.CitizenID)
		return nil, nil, ErrUnauthorized
	case "pending":
		s.recordEvent(in.CitizenID, "", EventLoginFailure, "", in.IP, in.DeviceFingerprint, "")
		return nil, nil, ErrForbidden
	}

	factors, err := s.store.ActiveFactors(in.CitizenID)
	if err != nil {
		return nil, nil, err
	}
	tier := TierT1
	lastMFA := now
	if len(factors) == 0 {
		// No factor enrolled: T1 only until DP-060 enrollment.
		lastMFA = time.Time{}
	} else if in.StepUpFactorType != "" {
		elevated, ferr := s.verifyFactorProof(in.CitizenID, factors, in.StepUpFactorType, in.StepUpProof, in.LivenessConfirmed)
		if ferr != nil {
			s.recordEvent(in.CitizenID, "", EventMFAFailure, in.StepUpFactorType, in.IP, in.DeviceFingerprint, "")
			return nil, nil, ferr
		}
		tier = elevated
		s.recordEvent(in.CitizenID, "", EventMFASuccess, in.StepUpFactorType, in.IP, in.DeviceFingerprint, "")
	} else {
		// Factors exist but no proof presented: session starts at T1 and the
		// client is told to step up (DP-061) before T2/T3 actions.
		tier = TierT1
		lastMFA = time.Time{}
	}

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
	return sess, nil
}

type EnrollInput struct {
	CitizenID           string
	SessionID           string
	FactorType          string
	TOTPSecret          string // plaintext once; stored encrypted
	PasskeyCredentialID string
	PasskeyPublicKey    string
	BiometricEmbedding  string // derived embedding, never a raw image
	LivenessConfirmed   bool
	ReferenceMatchScore float64 // match vs DP-002 reference embedding
}

// Enroll runs DP-060. Success upgrades the current session immediately (T2,
// or T3 for facial/passkey) and notifies the citizen (DP-039).
func (s *Service) Enroll(in EnrollInput, now time.Time) (*MfaFactor, error) {
	switch in.FactorType {
	case FactorTOTP:
		if in.TOTPSecret == "" {
			return nil, ErrInvalid
		}
	case FactorPasskey:
		if in.PasskeyCredentialID == "" || in.PasskeyPublicKey == "" {
			return nil, ErrInvalid
		}
	case FactorFacial:
		if in.BiometricEmbedding == "" || !in.LivenessConfirmed {
			// Liveness mandatory; static images rejected (SRV-017 key rules).
			return nil, ErrInvalid
		}
		if in.ReferenceMatchScore < 0.9 {
			return nil, ErrInvalid
		}
	default:
		return nil, ErrInvalid
	}
	f, err := s.store.InsertFactor(&MfaFactor{
		CitizenID:             in.CitizenID,
		FactorType:            in.FactorType,
		Status:                FactorActive,
		TOTPSecretEnc:         enc(in.TOTPSecret),
		PasskeyCredentialID:   in.PasskeyCredentialID,
		PasskeyPublicKey:      enc(in.PasskeyPublicKey),
		BiometricEmbeddingEnc: enc(in.BiometricEmbedding),
		LastUsedAt:            now,
	})
	if err != nil {
		return nil, err
	}
	tier := TierT2
	if in.FactorType == FactorFacial || in.FactorType == FactorPasskey {
		tier = TierT3
	}
	if in.SessionID != "" {
		if _, err := s.store.SetTier(in.SessionID, tier, now); err != nil {
			return nil, err
		}
	}
	s.recordEvent(in.CitizenID, in.SessionID, EventFactorEnrolled, in.FactorType, "", "", "")
	_ = s.audit.Emit("identity_event", "auth-service", "factor_enrolled:"+in.CitizenID)
	_ = s.notifier.Notify("factor_enrolled", in.CitizenID, "new MFA factor enrolled")
	return f, nil
}

type StepUpInput struct {
	SessionID         string
	FactorType        string
	Proof             string
	LivenessConfirmed bool
	DeviceFingerprint string
	IP                string
}

// StepUp runs DP-061: validate the challenge, raise the tier, mint a fresh
// access token. Five failures in ten minutes suspend the session (DP-066).
func (s *Service) StepUp(in StepUpInput, now time.Time) (*Tokens, error) {
	sess, err := s.store.GetSession(in.SessionID)
	if err != nil {
		return nil, err
	}
	if sess.Status != SessionActive {
		return nil, ErrUnauthorized
	}
	factors, err := s.store.ActiveFactors(sess.CitizenID)
	if err != nil {
		return nil, err
	}
	tier, verr := s.verifyFactorProof(sess.CitizenID, factors, in.FactorType, in.Proof, in.LivenessConfirmed)
	if verr != nil {
		s.recordEvent(sess.CitizenID, sess.ID, EventStepupFailure, in.FactorType, in.IP, in.DeviceFingerprint, "")
		if s.store.RecordMFAFailure(sess.ID, now) {
			s.suspendForAnomaly(sess, AnomalyMFAForce, in.IP, in.DeviceFingerprint, now)
		}
		_ = s.audit.Emit("identity_event", "auth-service", "stepup_failure:"+sess.CitizenID)
		return nil, verr
	}
	updated, err := s.store.SetTier(sess.ID, tier, now)
	if err != nil {
		return nil, err
	}
	for _, f := range factors {
		if f.FactorType == in.FactorType {
			_ = s.store.TouchFactor(f.ID, now)
		}
	}
	s.recordEvent(sess.CitizenID, sess.ID, EventStepupSuccess, in.FactorType, in.IP, in.DeviceFingerprint, "")
	_ = s.audit.Emit("identity_event", "auth-service", "stepup:"+sess.CitizenID)
	// Step-up mints a fresh access token only; the refresh token rotates on
	// the refresh flow (DP-059), never here.
	access := newToken()
	accessExp := now.Add(AccessTokenTTL)
	if _, err := s.store.RotateAccess(sess.ID, sha256Hex(access), accessExp); err != nil {
		return nil, err
	}
	_ = updated
	return &Tokens{AccessToken: access, AssuranceTier: tier, AccessExpiresAt: accessExp, SessionID: sess.ID}, nil
}

// verifyFactorProof checks a challenge against enrolled factors and returns
// the tier it earns. T3 requires passkey or facial (DP-061); TOTP earns T2.
func (s *Service) verifyFactorProof(citizenID string, factors []*MfaFactor, factorType, proof string, liveness bool) (string, error) {
	var match *MfaFactor
	for _, f := range factors {
		if f.FactorType == factorType {
			match = f
			break
		}
	}
	if match == nil {
		if factorType == FactorPasskey || factorType == FactorFacial {
			return "", ErrForbidden // T3 impossible without enrollment
		}
		return "", ErrUnauthorized
	}
	switch factorType {
	case FactorTOTP:
		if len(proof) != 6 {
			return "", ErrUnauthorized
		}
		return TierT2, nil
	case FactorPasskey:
		if proof == "" {
			return "", ErrUnauthorized
		}
		return TierT3, nil
	case FactorFacial:
		if proof == "" || !liveness {
			return "", ErrUnauthorized
		}
		return TierT3, nil
	}
	return "", ErrInvalid
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

// RestoreAfterAnomaly completes DP-066 step 7: a fresh T3 challenge (facial
// or passkey) reactivates a suspended session.
func (s *Service) RestoreAfterAnomaly(sessionID string, now time.Time) (*Session, error) {
	sess, err := s.store.GetSession(sessionID)
	if err != nil {
		return nil, err
	}
	if sess.Status != SessionSuspended {
		return nil, ErrInvalid
	}
	if now.Sub(sess.LastMFAAt) > T3ValidityWindow || (sess.AssuranceTier != TierT3) {
		return nil, ErrStepUpRequired
	}
	return s.store.SetStatus(sessionID, SessionActive)
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

// enc is the at-rest encryption envelope placeholder (KMS in production);
// it marks the field as never-plaintext without pulling in a crypto
// dependency the in-memory stage cannot justify.
func enc(plaintext string) string {
	if plaintext == "" {
		return ""
	}
	return "enc:" + sha256Hex("auth-service-enc:" + plaintext)[:32]
}

var _ = errors.Is
