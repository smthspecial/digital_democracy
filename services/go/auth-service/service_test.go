package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"testing"
	"time"
)

type recordingAuditEmitter struct {
	events []AuthEvent
}

func (r *recordingAuditEmitter) Emit(e AuthEvent) { r.events = append(r.events, e) }

func newTestService(t *testing.T) (*Service, *recordingAuditEmitter) {
	t.Helper()
	enc, err := newEncryptor()
	if err != nil {
		t.Fatalf("newEncryptor: %v", err)
	}
	audit := &recordingAuditEmitter{}
	return NewService(newStore(), enc, audit), audit
}

func mustDomainErr(t *testing.T, err error) *domainError {
	t.Helper()
	var de *domainError
	if !errors.As(err, &de) {
		t.Fatalf("expected *domainError, got %T: %v", err, err)
	}
	return de
}

// --- Login ---

func TestLogin(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()

	t.Run("invalid credential", func(t *testing.T) {
		svc, audit := newTestService(t)
		sess, stepUp, factors, err := svc.Login("citizen-1", CitizenActive, false, "fp", "10.0.0.0/24", now)
		if sess != nil || stepUp || factors != nil {
			t.Fatalf("expected nil session and no step-up, got %+v %v %v", sess, stepUp, factors)
		}
		if !errors.Is(err, errInvalidCredentials) {
			t.Fatalf("expected errInvalidCredentials, got %v", err)
		}
		if len(audit.events) != 1 || audit.events[0].EventType != EventLoginFailure {
			t.Fatalf("expected 1 login_failure audit event, got %+v", audit.events)
		}
	})

	for _, status := range []string{CitizenSuspended, CitizenRevoked} {
		t.Run("status "+status+" gives generic failure", func(t *testing.T) {
			svc, _ := newTestService(t)
			sess, _, _, err := svc.Login("citizen-1", status, true, "fp", "10.0.0.0/24", now)
			if sess != nil {
				t.Fatalf("expected nil session")
			}
			if !errors.Is(err, errAuthenticationFailed) {
				t.Fatalf("expected errAuthenticationFailed (no detail leak) for status=%s, got %v", status, err)
			}
		})
	}

	t.Run("pending status gives specific error", func(t *testing.T) {
		svc, _ := newTestService(t)
		sess, _, _, err := svc.Login("citizen-1", CitizenPending, true, "fp", "10.0.0.0/24", now)
		if sess != nil {
			t.Fatalf("expected nil session")
		}
		if !errors.Is(err, errIdentityVerificationRequired) {
			t.Fatalf("expected errIdentityVerificationRequired, got %v", err)
		}
	})

	t.Run("active with no enrolled factors", func(t *testing.T) {
		svc, audit := newTestService(t)
		sess, stepUp, factors, err := svc.Login("citizen-1", CitizenActive, true, "fp", "10.0.0.0/24", now)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if sess == nil {
			t.Fatalf("expected a session")
		}
		if sess.AssuranceTier != TierT1 {
			t.Errorf("expected T1, got %s", sess.AssuranceTier)
		}
		if stepUp {
			t.Errorf("expected requiresStepUp=false with no enrolled factors")
		}
		if len(factors) != 0 {
			t.Errorf("expected no available factor types, got %v", factors)
		}
		if sess.AccessToken == "" || sess.RefreshToken == "" {
			t.Errorf("expected plaintext tokens in the response")
		}
		found := false
		for _, e := range audit.events {
			if e.EventType == EventLoginSuccess {
				found = true
			}
		}
		if !found {
			t.Errorf("expected login_success audit event")
		}
	})

	t.Run("active with enrolled factors requires step-up", func(t *testing.T) {
		svc, _ := newTestService(t)
		svc.store.CreateFactor(MFAFactor{CitizenID: "citizen-1", FactorType: FactorTOTP, Status: FactorActive})

		sess, stepUp, factors, err := svc.Login("citizen-1", CitizenActive, true, "fp", "10.0.0.0/24", now)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if !stepUp {
			t.Errorf("expected requiresStepUp=true")
		}
		if len(factors) != 1 || factors[0] != "totp" {
			t.Errorf("expected [totp], got %v", factors)
		}
		if sess.AssuranceTier != TierT1 {
			t.Errorf("session stays T1 until step-up is completed, got %s", sess.AssuranceTier)
		}
	})
}

// --- EnrollFactor ---

func TestEnrollFactorTOTP(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, audit := newTestService(t)
	sess := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive, AssuranceTier: TierT1})

	secret := totpGenerateSecret()
	code, err := totpCode(secret, now)
	if err != nil {
		t.Fatalf("totpCode: %v", err)
	}

	factor, err := svc.EnrollFactor("c1", sess.ID, "totp", EnrollmentData{TOTPSecret: secret, TOTPCode: code}, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if factor.Status != FactorActive || factor.FactorType != FactorTOTP {
		t.Fatalf("unexpected factor: %+v", factor)
	}
	if len(factor.TOTPSecretEnc) == 0 {
		t.Errorf("expected encrypted secret to be stored")
	}

	updatedSess, _ := svc.store.GetSession(sess.ID)
	if updatedSess.AssuranceTier != TierT2 {
		t.Errorf("expected session upgraded to T2, got %s", updatedSess.AssuranceTier)
	}
	if !updatedSess.LastMFAAt.Equal(now) {
		t.Errorf("expected last_mfa_at = %v, got %v", now, updatedSess.LastMFAAt)
	}

	found := false
	for _, e := range audit.events {
		if e.EventType == EventFactorEnrolled {
			found = true
		}
	}
	if !found {
		t.Errorf("expected factor_enrolled audit event")
	}
}

func TestEnrollFactorTOTPWrongCode(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, _ := newTestService(t)
	sess := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive})

	secret := totpGenerateSecret()
	_, err := svc.EnrollFactor("c1", sess.ID, "totp", EnrollmentData{TOTPSecret: secret, TOTPCode: "000000"}, now)
	if !errors.Is(err, errInvalidProof) {
		t.Fatalf("expected errInvalidProof, got %v", err)
	}
}

func TestEnrollFactorPasskey(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, _ := newTestService(t)
	sess := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive})

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	pubDER, err := marshalECDSAPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatalf("marshalECDSAPublicKey: %v", err)
	}
	challenge := generatePasskeyChallenge()
	hash := sha256.Sum256(challenge)
	sig, err := ecdsa.SignASN1(rand.Reader, priv, hash[:])
	if err != nil {
		t.Fatalf("SignASN1: %v", err)
	}

	factor, err := svc.EnrollFactor("c1", sess.ID, "passkey", EnrollmentData{
		PasskeyCredentialID: "cred-1",
		PasskeyPublicKeyDER: pubDER,
		PasskeyChallenge:    challenge,
		PasskeySignature:    sig,
	}, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if factor.PasskeyCredentialID != "cred-1" {
		t.Errorf("expected credential id stored")
	}

	updatedSess, _ := svc.store.GetSession(sess.ID)
	if updatedSess.AssuranceTier != TierT3 {
		t.Errorf("expected T3 for passkey enrollment, got %s", updatedSess.AssuranceTier)
	}
}

func TestEnrollFactorPasskeyWrongSignature(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, _ := newTestService(t)
	sess := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive})

	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pubDER, _ := marshalECDSAPublicKey(&priv.PublicKey)
	wrongPriv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	challenge := generatePasskeyChallenge()
	hash := sha256.Sum256(challenge)
	wrongSig, _ := ecdsa.SignASN1(rand.Reader, wrongPriv, hash[:])

	_, err := svc.EnrollFactor("c1", sess.ID, "passkey", EnrollmentData{
		PasskeyCredentialID: "cred-1",
		PasskeyPublicKeyDER: pubDER,
		PasskeyChallenge:    challenge,
		PasskeySignature:    wrongSig,
	}, now)
	if !errors.Is(err, errInvalidProof) {
		t.Fatalf("expected errInvalidProof, got %v", err)
	}
}

func TestEnrollFactorFacial(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, _ := newTestService(t)
	sess := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive})

	ref := []float64{1, 0, 0, 0}
	submitted := []float64{1, 0, 0, 0}

	t.Run("rejects when liveness is false even if embeddings match", func(t *testing.T) {
		_, err := svc.EnrollFactor("c1", sess.ID, "facial", EnrollmentData{
			Embedding: submitted, ReferenceEmbedding: ref, Liveness: false,
		}, now)
		if err == nil {
			t.Fatalf("expected liveness rejection error")
		}
	})

	t.Run("rejects below confidence threshold even with liveness", func(t *testing.T) {
		lowMatch := []float64{0, 1, 0, 0}
		_, err := svc.EnrollFactor("c1", sess.ID, "facial", EnrollmentData{
			Embedding: lowMatch, ReferenceEmbedding: ref, Liveness: true,
		}, now)
		if !errors.Is(err, errInvalidProof) {
			t.Fatalf("expected errInvalidProof for low-confidence match, got %v", err)
		}
	})

	t.Run("succeeds with liveness and matching embedding", func(t *testing.T) {
		factor, err := svc.EnrollFactor("c1", sess.ID, "facial", EnrollmentData{
			Embedding: submitted, ReferenceEmbedding: ref, Liveness: true,
		}, now)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if len(factor.BiometricEmbeddingEnc) == 0 {
			t.Errorf("expected encrypted embedding stored")
		}
		updatedSess, _ := svc.store.GetSession(sess.ID)
		if updatedSess.AssuranceTier != TierT3 {
			t.Errorf("expected T3 for facial enrollment, got %s", updatedSess.AssuranceTier)
		}
	})
}

func TestEnrollFactorSessionOwnershipAndExistence(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, _ := newTestService(t)

	_, err := svc.EnrollFactor("c1", "no-such-session", "totp", EnrollmentData{}, now)
	if !errors.Is(err, errSessionNotFound) {
		t.Fatalf("expected errSessionNotFound, got %v", err)
	}

	sess := svc.store.CreateSession(Session{CitizenID: "someone-else", Status: SessionActive})
	_, err = svc.EnrollFactor("c1", sess.ID, "totp", EnrollmentData{}, now)
	if err == nil {
		t.Fatalf("expected an error enrolling against another citizen's session")
	}
}

// --- CompleteStepUp ---

func TestCompleteStepUpTOTP(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, audit := newTestService(t)
	secret := totpGenerateSecret()
	encSecret, _ := svc.enc.encrypt([]byte(secret))
	svc.store.CreateFactor(MFAFactor{ID: "f1", CitizenID: "c1", FactorType: FactorTOTP, Status: FactorActive, TOTPSecretEnc: encSecret})
	sess := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive, AssuranceTier: TierT1})

	code, _ := totpCode(secret, now)
	updated, err := svc.CompleteStepUp(sess.ID, "T2", "totp", StepUpProof{TOTPCode: code}, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.AssuranceTier != TierT2 {
		t.Errorf("expected T2, got %s", updated.AssuranceTier)
	}
	if updated.AccessToken == "" {
		t.Errorf("expected a reissued access token in the response")
	}
	found := false
	for _, e := range audit.events {
		if e.EventType == EventStepupSuccess {
			found = true
		}
	}
	if !found {
		t.Errorf("expected stepup_success audit event")
	}
}

func TestCompleteStepUpT3RequiresStrongFactor(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, _ := newTestService(t)
	svc.store.CreateFactor(MFAFactor{CitizenID: "c1", FactorType: FactorTOTP, Status: FactorActive})
	sess := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive})

	_, err := svc.CompleteStepUp(sess.ID, "T3", "totp", StepUpProof{TOTPCode: "123456"}, now)
	de := mustDomainErr(t, err)
	if de.kind != kindValidation {
		t.Errorf("expected validation-kind rejection for T3 via totp, got %v", de.kind)
	}
}

func TestCompleteStepUpRejectsInvalidTier(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, _ := newTestService(t)
	sess := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive})

	_, err := svc.CompleteStepUp(sess.ID, "T1", "totp", StepUpProof{}, now)
	de := mustDomainErr(t, err)
	if de.kind != kindValidation {
		t.Errorf("expected validation-kind rejection for tier=T1, got %v", de.kind)
	}
}

func TestCompleteStepUpNoEnrolledFactor(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, _ := newTestService(t)
	sess := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive})

	_, err := svc.CompleteStepUp(sess.ID, "T2", "totp", StepUpProof{TOTPCode: "123456"}, now)
	if !errors.Is(err, errFactorNotEnrolled) {
		t.Fatalf("expected errFactorNotEnrolled, got %v", err)
	}
}

func TestCompleteStepUpBruteForceLockoutAndRecovery(t *testing.T) {
	base := time.Unix(1_700_000_000, 0).UTC()
	svc, audit := newTestService(t)

	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pubDER, _ := marshalECDSAPublicKey(&priv.PublicKey)
	svc.store.CreateFactor(MFAFactor{CitizenID: "c1", FactorType: FactorPasskey, Status: FactorActive, PasskeyPublicKey: pubDER})
	sess := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive})

	badProof := StepUpProof{PasskeyChallenge: []byte("challenge"), PasskeySignature: []byte("not-a-real-signature")}

	for i := 0; i < 4; i++ {
		at := base.Add(time.Duration(i) * time.Minute)
		_, err := svc.CompleteStepUp(sess.ID, "T3", "passkey", badProof, at)
		if !errors.Is(err, errInvalidProof) {
			t.Fatalf("attempt %d: expected errInvalidProof, got %v", i, err)
		}
		s, _ := svc.store.GetSession(sess.ID)
		if s.Status != SessionActive {
			t.Fatalf("attempt %d: session should not be suspended yet, status=%s", i, s.Status)
		}
	}

	// 5th failure within the 10-minute window trips the brute-force lockout
	_, err := svc.CompleteStepUp(sess.ID, "T3", "passkey", badProof, base.Add(4*time.Minute))
	if !errors.Is(err, errInvalidProof) {
		t.Fatalf("expected errInvalidProof, got %v", err)
	}
	suspended, _ := svc.store.GetSession(sess.ID)
	if suspended.Status != SessionSuspended {
		t.Fatalf("expected session suspended after 5 failures, got %s", suspended.Status)
	}
	anomalyFound := false
	for _, e := range audit.events {
		if e.EventType == EventAnomalyDetected && e.AnomalyReason == "mfa_brute_force" {
			anomalyFound = true
		}
	}
	if !anomalyFound {
		t.Fatalf("expected anomaly_detected/mfa_brute_force audit event")
	}

	// A successful T3 step-up now restores the session from suspended to active
	challenge := generatePasskeyChallenge()
	hash := sha256.Sum256(challenge)
	sig, _ := ecdsa.SignASN1(rand.Reader, priv, hash[:])
	goodProof := StepUpProof{PasskeyChallenge: challenge, PasskeySignature: sig}

	restored, err := svc.CompleteStepUp(sess.ID, "T3", "passkey", goodProof, base.Add(5*time.Minute))
	if err != nil {
		t.Fatalf("unexpected error recovering with valid step-up: %v", err)
	}
	if restored.Status != SessionActive {
		t.Fatalf("expected session restored to active, got %s", restored.Status)
	}
}

// --- RefreshToken ---

func TestRefreshTokenHappyPath(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, _ := newTestService(t)
	sess, _, _, err := svc.Login("c1", CitizenActive, true, "fp-1", "10.0.0.0/24", now)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	oldRefresh := sess.RefreshToken

	updated, newRefresh, err := svc.RefreshToken(oldRefresh, "fp-1", "10.0.0.0/24", now.Add(time.Minute))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if newRefresh == "" || newRefresh == oldRefresh {
		t.Fatalf("expected a distinct new refresh token")
	}
	if updated.AccessToken == "" {
		t.Fatalf("expected a reissued access token")
	}

	// old refresh token must no longer work
	if _, _, err := svc.RefreshToken(oldRefresh, "fp-1", "10.0.0.0/24", now.Add(2*time.Minute)); err == nil {
		t.Fatalf("expected old refresh token to be rejected after rotation")
	}
}

func TestRefreshTokenDeviceMismatchTriggersAnomaly(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, audit := newTestService(t)
	sess, _, _, err := svc.Login("c1", CitizenActive, true, "fp-1", "10.0.0.0/24", now)
	if err != nil {
		t.Fatalf("login: %v", err)
	}

	_, _, err = svc.RefreshToken(sess.RefreshToken, "different-fp", "10.0.0.0/24", now.Add(time.Minute))
	if err == nil {
		t.Fatalf("expected an error on fingerprint mismatch")
	}
	updated, _ := svc.store.GetSession(sess.ID)
	if updated.Status != SessionSuspended {
		t.Fatalf("expected session suspended, got %s", updated.Status)
	}
	found := false
	for _, e := range audit.events {
		if e.EventType == EventAnomalyDetected && e.AnomalyReason == "new_device" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected anomaly_detected/new_device event")
	}
}

func TestRefreshTokenTierDowngradeAfter12Hours(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, _ := newTestService(t)
	sess := svc.store.CreateSession(Session{
		CitizenID: "c1", Status: SessionActive, AssuranceTier: TierT2,
		DeviceFingerprint: "fp-1", IPSubnet: "10.0.0.0/24", LastMFAAt: now,
		ExpiresAt: now.Add(30 * 24 * time.Hour),
	})
	_, refreshHash, _ := generateTokenPair()
	plain, _ := generateRandomToken()
	refreshHash = hashToken(plain)
	sess.RefreshTokenHash = refreshHash
	svc.store.SaveSession(sess)

	later := now.Add(13 * time.Hour)
	updated, _, err := svc.RefreshToken(plain, "fp-1", "10.0.0.0/24", later)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated.AssuranceTier != TierT1 {
		t.Fatalf("expected downgrade to T1 after 12h without MFA, got %s", updated.AssuranceTier)
	}
}

func TestRefreshTokenReuseDetection(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, audit := newTestService(t)
	sess, _, _, err := svc.Login("c1", CitizenActive, true, "fp-1", "10.0.0.0/24", now)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	original := sess.RefreshToken

	_, _, err = svc.RefreshToken(original, "fp-1", "10.0.0.0/24", now.Add(time.Minute))
	if err != nil {
		t.Fatalf("first refresh: %v", err)
	}

	_, _, err = svc.RefreshToken(original, "fp-1", "10.0.0.0/24", now.Add(2*time.Minute))
	if err == nil {
		t.Fatalf("expected reuse of a rotated-away token to fail")
	}
	updated, _ := svc.store.GetSession(sess.ID)
	if updated.Status != SessionSuspended {
		t.Fatalf("expected session suspended on token reuse, got %s", updated.Status)
	}
	found := false
	for _, e := range audit.events {
		if e.EventType == EventAnomalyDetected && e.AnomalyReason == "token_reuse" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected anomaly_detected/token_reuse event")
	}
}

func TestRefreshTokenUnknownToken(t *testing.T) {
	svc, _ := newTestService(t)
	_, _, err := svc.RefreshToken("not-a-real-token", "fp", "subnet", time.Now())
	if err == nil {
		t.Fatalf("expected an error for an unrecognized refresh token")
	}
}

// --- Logout ---

func TestLogout(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, audit := newTestService(t)
	sess := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive, RefreshTokenHash: "rt-hash"})

	if err := svc.Logout(sess.ID, now); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	updated, _ := svc.store.GetSession(sess.ID)
	if updated.Status != SessionRevoked {
		t.Errorf("expected revoked, got %s", updated.Status)
	}
	if updated.RefreshTokenHash != "" {
		t.Errorf("expected refresh token hash zeroed")
	}
	found := false
	for _, e := range audit.events {
		if e.EventType == EventSessionRevoked {
			found = true
		}
	}
	if !found {
		t.Errorf("expected session_revoked audit event")
	}

	if err := svc.Logout("no-such-session", now); !errors.Is(err, errSessionNotFound) {
		t.Errorf("expected errSessionNotFound, got %v", err)
	}
}

// --- ValidateAccessToken ---

func TestValidateAccessToken(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, _ := newTestService(t)
	plain, hash, _ := generateTokenPair()
	sess := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive, AccessTokenHash: hash, ExpiresAt: now.Add(time.Hour)})

	got, err := svc.ValidateAccessToken(plain, now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.ID != sess.ID {
		t.Errorf("expected matching session")
	}

	if _, err := svc.ValidateAccessToken(plain, now.Add(2*time.Hour)); err == nil {
		t.Errorf("expected expired token to be rejected")
	}
	if _, err := svc.ValidateAccessToken("garbage", now); err == nil {
		t.Errorf("expected unknown token to be rejected")
	}

	revoked := sess
	revoked.Status = SessionRevoked
	svc.store.SaveSession(revoked)
	if _, err := svc.ValidateAccessToken(plain, now); err == nil {
		t.Errorf("expected revoked session's token to be rejected")
	}
}

// --- RevokeAllSessions ---

func TestRevokeAllSessions(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, audit := newTestService(t)
	svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive})
	svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionSuspended})
	svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionRevoked})
	svc.store.CreateSession(Session{CitizenID: "other", Status: SessionActive})

	n, err := svc.RevokeAllSessions("c1", now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 2 {
		t.Fatalf("expected 2 sessions revoked, got %d", n)
	}
	for _, sess := range svc.store.SessionsByCitizen("c1") {
		if sess.Status != SessionRevoked {
			t.Errorf("expected all c1 sessions revoked, got %+v", sess)
		}
	}
	for _, sess := range svc.store.SessionsByCitizen("other") {
		if sess.Status != SessionActive {
			t.Errorf("expected other citizen's session untouched")
		}
	}
	count := 0
	for _, e := range audit.events {
		if e.EventType == EventSessionRevoked {
			count++
		}
	}
	if count != 2 {
		t.Errorf("expected 2 session_revoked audit events, got %d", count)
	}
}

// --- PurgeExpiredSessions ---

func TestPurgeExpiredSessionsNeverRemovesRevoked(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	svc, _ := newTestService(t)

	revokedOld := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionRevoked, ExpiresAt: now.Add(-1000 * time.Hour)})
	activeExpired := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive, ExpiresAt: now.Add(-25 * time.Hour)})
	activeRecent := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive, ExpiresAt: now.Add(time.Hour)})

	n, err := svc.PurgeExpiredSessions(now)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected exactly 1 purged, got %d", n)
	}
	if _, ok := svc.store.GetSession(revokedOld.ID); !ok {
		t.Errorf("revoked session must never be purged")
	}
	if _, ok := svc.store.GetSession(activeExpired.ID); ok {
		t.Errorf("expired active session should have been purged")
	}
	if _, ok := svc.store.GetSession(activeRecent.ID); !ok {
		t.Errorf("non-expired session should remain")
	}
}
