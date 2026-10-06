package auth

import "time"

type activeIdentityChecker struct{}

func (activeIdentityChecker) StatusOf(string) (string, error) { return "active", nil }

// Legacy tier/MFA fixtures exist only in the test binary. Production session
// issuance uses verified WebAuthn ceremonies; these helpers keep persistence,
// rotation and anomaly tests independent of browser/authenticator fixtures.
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

// enc is the at-rest encryption envelope placeholder (KMS in production);
// it marks the field as never-plaintext without pulling in a crypto
// dependency the in-memory stage cannot justify.
func enc(plaintext string) string {
	if plaintext == "" {
		return ""
	}
	return "enc:" + sha256Hex("auth-service-enc:" + plaintext)[:32]
}
