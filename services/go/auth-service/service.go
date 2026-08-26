package main

import (
	"time"
)

const (
	// ADR-014 tier validity windows.
	tierT2ValidityWindow = 12 * time.Hour

	bruteForceWindow    = 10 * time.Minute
	bruteForceThreshold = 5

	// ADR-014 does not pin an exact absolute session deadline; a conservative
	// default is used here for the refresh/session-level expires_at boundary.
	// ValidateAccessToken also uses this same field as the access token's
	// effective deadline in this phase — a production deployment would give
	// the 15-minute access-token TTL (SRV-017) its own short-lived claim
	// (e.g. a JWT exp) rather than sharing the session's expiry.
	defaultSessionTTL = 24 * time.Hour

	// DP-067 purge grace window past expires_at.
	purgeGracePeriod = 24 * time.Hour
)

// AuditEmitter models DP-036 (audit.append): in a real deployment this
// publishes to the audit-service queue. The default implementation wired in
// main.go is a no-op.
type AuditEmitter interface {
	Emit(event AuthEvent)
}

type noopAuditEmitter struct{}

func (noopAuditEmitter) Emit(AuthEvent) {}

type Service struct {
	store *store
	enc   *encryptor
	audit AuditEmitter
}

func NewService(st *store, enc *encryptor, audit AuditEmitter) *Service {
	if audit == nil {
		audit = noopAuditEmitter{}
	}
	return &Service{store: st, enc: enc, audit: audit}
}

func (s *Service) recordEvent(e AuthEvent) AuthEvent {
	e = s.store.AppendEvent(e)
	s.audit.Emit(e)
	return e
}

// Login implements DP-059's login flow. There is no live identity-service
// integration in this phase, so citizenStatus and credentialValid are trusted
// as explicit caller-supplied input (see handlers.go) rather than looked up.
func (s *Service) Login(citizenID, citizenStatus string, credentialValid bool, deviceFingerprint, ipSubnet string, now time.Time) (*Session, bool, []string, error) {
	fail := func(err error) (*Session, bool, []string, error) {
		s.recordEvent(AuthEvent{
			CitizenID: citizenID, EventType: EventLoginFailure,
			DeviceFingerprint: deviceFingerprint, IPAddress: ipSubnet, CreatedAt: now,
		})
		return nil, false, nil, err
	}

	if !credentialValid {
		return fail(errInvalidCredentials)
	}
	switch citizenStatus {
	case CitizenPending:
		return fail(errIdentityVerificationRequired)
	case CitizenActive:
	default:
		// suspended, revoked, or any unrecognized status: deny with no detail leak
		return fail(errAuthenticationFailed)
	}

	factorTypes := s.store.ActiveFactorTypes(citizenID)

	accessPlain, accessHash, err := generateTokenPair()
	if err != nil {
		return nil, false, nil, err
	}
	refreshPlain, refreshHash, err := generateTokenPair()
	if err != nil {
		return nil, false, nil, err
	}

	persisted := s.store.CreateSession(Session{
		CitizenID:         citizenID,
		AccessTokenHash:   accessHash,
		RefreshTokenHash:  refreshHash,
		DeviceFingerprint: deviceFingerprint,
		IPSubnet:          ipSubnet,
		AssuranceTier:     TierT1,
		LastRefreshAt:     now,
		ExpiresAt:         now.Add(defaultSessionTTL),
		Status:            SessionActive,
		CreatedAt:         now,
	})

	s.recordEvent(AuthEvent{
		CitizenID: citizenID, SessionID: persisted.ID, EventType: EventLoginSuccess,
		DeviceFingerprint: deviceFingerprint, IPAddress: ipSubnet, CreatedAt: now,
	})

	response := persisted
	response.AccessToken = accessPlain
	response.RefreshToken = refreshPlain
	return &response, len(factorTypes) > 0, factorTypes, nil
}

// EnrollFactor implements DP-060. In this phase there is no separate "begin
// enrollment" round trip (see EnrollmentData), so the caller supplies the full
// proof material for the chosen factor type in one call.
func (s *Service) EnrollFactor(citizenID, sessionID string, factorType string, data EnrollmentData, now time.Time) (*MFAFactor, error) {
	sess, ok := s.store.GetSession(sessionID)
	if !ok {
		return nil, errSessionNotFound
	}
	if sess.CitizenID != citizenID {
		return nil, newDomainError(kindForbidden, "session does not belong to this citizen")
	}

	ft := FactorType(factorType)
	factor := MFAFactor{CitizenID: citizenID, FactorType: ft, Status: FactorActive, EnrolledAt: now}

	switch ft {
	case FactorTOTP:
		if data.TOTPSecret == "" || data.TOTPCode == "" {
			return nil, errValidation("totp_secret and totp_code are required")
		}
		if !totpValidate(data.TOTPSecret, data.TOTPCode, now) {
			return nil, errInvalidProof
		}
		encSecret, err := s.enc.encrypt([]byte(data.TOTPSecret))
		if err != nil {
			return nil, err
		}
		factor.TOTPSecretEnc = encSecret

	case FactorPasskey:
		if len(data.PasskeyPublicKeyDER) == 0 || len(data.PasskeyChallenge) == 0 || len(data.PasskeySignature) == 0 || data.PasskeyCredentialID == "" {
			return nil, errValidation("passkey public key, challenge, signature and credential id are required")
		}
		if !verifyPasskeySignature(data.PasskeyPublicKeyDER, data.PasskeyChallenge, data.PasskeySignature) {
			return nil, errInvalidProof
		}
		factor.PasskeyCredentialID = data.PasskeyCredentialID
		factor.PasskeyPublicKey = data.PasskeyPublicKeyDER

	case FactorFacial:
		if !data.Liveness {
			return nil, newDomainError(kindForbidden, "liveness check failed")
		}
		if len(data.Embedding) == 0 || len(data.ReferenceEmbedding) == 0 {
			return nil, errValidation("embedding and reference_embedding are required")
		}
		if cosineSimilarity(data.Embedding, data.ReferenceEmbedding) < facialConfidenceThreshold {
			return nil, errInvalidProof
		}
		encEmb, err := s.enc.encrypt(floatsToBytes(data.Embedding))
		if err != nil {
			return nil, err
		}
		factor.BiometricEmbeddingEnc = encEmb

	default:
		return nil, errValidation("unknown factor_type")
	}

	stored := s.store.CreateFactor(factor)

	s.recordEvent(AuthEvent{
		CitizenID: citizenID, SessionID: sessionID, EventType: EventFactorEnrolled,
		FactorType: ft, CreatedAt: now,
	})

	newTier := TierT2
	if ft == FactorPasskey || ft == FactorFacial {
		newTier = TierT3
	}
	sess.AssuranceTier = newTier
	sess.LastMFAAt = now
	s.store.SaveSession(sess)

	return &stored, nil
}

// CompleteStepUp implements DP-061.
func (s *Service) CompleteStepUp(sessionID string, requestedTier string, factorType string, proof StepUpProof, now time.Time) (*Session, error) {
	sess, ok := s.store.GetSession(sessionID)
	if !ok {
		return nil, errSessionNotFound
	}
	if sess.Status == SessionRevoked {
		return nil, errSessionRevoked
	}

	tier := AssuranceTier(requestedTier)
	ft := FactorType(factorType)
	if tier != TierT2 && tier != TierT3 {
		return nil, errValidation("tier must be T2 or T3")
	}
	if tier == TierT3 && ft != FactorPasskey && ft != FactorFacial {
		return nil, errValidation("T3 requires a passkey or facial factor")
	}

	factor, ok := s.store.ActiveFactor(sess.CitizenID, ft)
	if !ok {
		return nil, errFactorNotEnrolled
	}

	if !s.verifyStepUpProof(factor, ft, proof, now) {
		s.recordEvent(AuthEvent{
			CitizenID: sess.CitizenID, SessionID: sessionID, EventType: EventStepupFailure,
			FactorType: ft, CreatedAt: now,
		})
		count := s.store.RecordFailure(sess.CitizenID, now, bruteForceWindow)
		if count >= bruteForceThreshold {
			sess.Status = SessionSuspended
			s.store.SaveSession(sess)
			s.recordEvent(AuthEvent{
				CitizenID: sess.CitizenID, SessionID: sessionID, EventType: EventAnomalyDetected,
				AnomalyReason: "mfa_brute_force", CreatedAt: now,
			})
		}
		return nil, errInvalidProof
	}

	factor.LastUsedAt = now
	s.store.SaveFactor(factor)

	sess.AssuranceTier = tier
	sess.LastMFAAt = now
	if sess.Status == SessionSuspended && tier == TierT3 {
		sess.Status = SessionActive
	}

	accessPlain, accessHash, err := generateTokenPair()
	if err != nil {
		return nil, err
	}
	sess.AccessTokenHash = accessHash
	s.store.SaveSession(sess)
	s.store.ResetFailures(sess.CitizenID)

	s.recordEvent(AuthEvent{
		CitizenID: sess.CitizenID, SessionID: sessionID, EventType: EventStepupSuccess,
		FactorType: ft, CreatedAt: now,
	})

	response := sess
	response.AccessToken = accessPlain
	return &response, nil
}

func (s *Service) verifyStepUpProof(factor MFAFactor, ft FactorType, proof StepUpProof, now time.Time) bool {
	switch ft {
	case FactorTOTP:
		secret, err := s.enc.decrypt(factor.TOTPSecretEnc)
		if err != nil {
			return false
		}
		return totpValidate(string(secret), proof.TOTPCode, now)
	case FactorPasskey:
		return verifyPasskeySignature(factor.PasskeyPublicKey, proof.PasskeyChallenge, proof.PasskeySignature)
	case FactorFacial:
		if !proof.Liveness {
			return false
		}
		embBytes, err := s.enc.decrypt(factor.BiometricEmbeddingEnc)
		if err != nil {
			return false
		}
		return cosineSimilarity(bytesToFloats(embBytes), proof.Embedding) >= facialConfidenceThreshold
	default:
		return false
	}
}

// RefreshToken implements DP-059's token refresh flow.
func (s *Service) RefreshToken(refreshTokenPlain, deviceFingerprint, ipSubnet string, now time.Time) (*Session, string, error) {
	hash := hashToken(refreshTokenPlain)

	sess, ok := s.store.GetSessionByRefreshHash(hash)
	if !ok {
		if sessionID, reused := s.store.RefreshHashSuperseded(hash); reused {
			s.suspendForAnomaly(sessionID, "token_reuse", deviceFingerprint, ipSubnet, now)
		}
		return nil, "", errAuthenticationFailed
	}
	if sess.Status != SessionActive {
		return nil, "", errAuthenticationFailed
	}
	if sess.DeviceFingerprint != deviceFingerprint || sess.IPSubnet != ipSubnet {
		s.suspendForAnomaly(sess.ID, "new_device", deviceFingerprint, ipSubnet, now)
		return nil, "", errAuthenticationFailed
	}

	newRefreshPlain, newRefreshHash, err := generateTokenPair()
	if err != nil {
		return nil, "", err
	}
	newAccessPlain, newAccessHash, err := generateTokenPair()
	if err != nil {
		return nil, "", err
	}

	sess.RefreshTokenHash = newRefreshHash
	sess.AccessTokenHash = newAccessHash
	sess.LastRefreshAt = now
	if now.Sub(sess.LastMFAAt) > tierT2ValidityWindow {
		sess.AssuranceTier = TierT1
	}
	s.store.SaveSession(sess)

	response := sess
	response.AccessToken = newAccessPlain
	return &response, newRefreshPlain, nil
}

func (s *Service) suspendForAnomaly(sessionID, reason, deviceFingerprint, ipSubnet string, now time.Time) {
	sess, ok := s.store.GetSession(sessionID)
	if !ok {
		return
	}
	sess.Status = SessionSuspended
	s.store.SaveSession(sess)
	s.recordEvent(AuthEvent{
		CitizenID: sess.CitizenID, SessionID: sessionID, EventType: EventAnomalyDetected,
		AnomalyReason: reason, DeviceFingerprint: deviceFingerprint, IPAddress: ipSubnet, CreatedAt: now,
	})
}

// Logout implements DP-059's logout flow.
func (s *Service) Logout(sessionID string, now time.Time) error {
	sess, ok := s.store.GetSession(sessionID)
	if !ok {
		return errSessionNotFound
	}
	if sess.Status == SessionRevoked {
		return nil
	}
	sess.Status = SessionRevoked
	sess.RefreshTokenHash = ""
	s.store.SaveSession(sess)

	s.recordEvent(AuthEvent{CitizenID: sess.CitizenID, SessionID: sessionID, EventType: EventSessionRevoked, CreatedAt: now})
	return nil
}

// ValidateAccessToken is called internally by every other service on each
// authenticated request.
func (s *Service) ValidateAccessToken(accessTokenPlain string, now time.Time) (*Session, error) {
	sess, ok := s.store.GetSessionByAccessHash(hashToken(accessTokenPlain))
	if !ok {
		return nil, errTokenInvalid
	}
	if sess.Status != SessionActive {
		return nil, errTokenInvalid
	}
	if now.After(sess.ExpiresAt) {
		return nil, errTokenInvalid
	}
	return &sess, nil
}

// RevokeAllSessions is consumed only by identity-service (DP-042/DP-035:
// multi-approval forced revocation).
func (s *Service) RevokeAllSessions(citizenID string, now time.Time) (int, error) {
	count := 0
	for _, sess := range s.store.SessionsByCitizen(citizenID) {
		if sess.Status == SessionRevoked {
			continue
		}
		sess.Status = SessionRevoked
		sess.RefreshTokenHash = ""
		s.store.SaveSession(sess)
		s.recordEvent(AuthEvent{CitizenID: citizenID, SessionID: sess.ID, EventType: EventSessionRevoked, CreatedAt: now})
		count++
	}
	return count, nil
}

// PurgeExpiredSessions implements DP-067. Revoked sessions are never purged —
// they are retained indefinitely for audit.
func (s *Service) PurgeExpiredSessions(now time.Time) (int, error) {
	n := s.store.PurgeSessions(func(sess Session) bool {
		return sess.Status != SessionRevoked && sess.ExpiresAt.Add(purgeGracePeriod).Before(now)
	})
	return n, nil
}
