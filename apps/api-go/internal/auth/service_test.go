package auth

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func testService() *Service { return NewService(nil, nil, nil, nil) }

func login(t *testing.T, svc *Service, citizen string) (*Session, *Tokens) {
	t.Helper()
	sess, tokens, err := svc.Login(LoginInput{
		CitizenID: citizen, DeviceFingerprint: "fp-1", IP: "10.0.0.1", IPSubnet: "10.0.0.0/24",
	}, time.Now().UTC())
	if err != nil {
		t.Fatalf("Login: %v", err)
	}
	return sess, tokens
}

// DP-059: fresh citizens start at T1; enrolled citizens without proof get
// step-up-required T1; valid proof elevates.
func TestLoginTiers(t *testing.T) {
	svc := testService()
	now := time.Now().UTC()
	_, tokens, _ := svc.Login(LoginInput{CitizenID: "c1", DeviceFingerprint: "fp", IPSubnet: "s"}, now)
	if tokens.AssuranceTier != TierT1 {
		t.Fatalf("unenrolled tier = %q, want T1", tokens.AssuranceTier)
	}

	// Enroll TOTP directly, then log in with and without proof.
	svc.Enroll(EnrollInput{CitizenID: "c2", FactorType: FactorTOTP, TOTPSecret: "secret"}, now)
	_, noProof, err := svc.Login(LoginInput{CitizenID: "c2", DeviceFingerprint: "fp", IPSubnet: "s"}, now)
	if err != nil || noProof.AssuranceTier != TierT1 {
		t.Fatalf("no-proof login = %v, %v", noProof, err)
	}
	_, withProof, err := svc.Login(LoginInput{
		CitizenID: "c2", DeviceFingerprint: "fp", IPSubnet: "s",
		StepUpFactorType: FactorTOTP, StepUpProof: "123456",
	}, now)
	if err != nil || withProof.AssuranceTier != TierT2 {
		t.Fatalf("totp login = %v, %v", withProof, err)
	}
}

// DP-059: suspended/revoked leak no detail (same 401 as bad credentials);
// pending is told to verify identity.
func TestLoginStatusGates(t *testing.T) {
	now := time.Now().UTC()
	for status, want := range map[string]error{"suspended": ErrUnauthorized, "revoked": ErrUnauthorized, "pending": ErrForbidden} {
		svc := NewService(nil, IdentityCheckerFunc(func(string) (string, error) { return status, nil }), nil, nil)
		_, _, err := svc.Login(LoginInput{CitizenID: "c", DeviceFingerprint: "fp", IPSubnet: "s"}, now)
		if err != want {
			t.Fatalf("status %s: err = %v, want %v", status, err, want)
		}
	}
}

// BUG-002: identity-service's real CitizenStatus vocabulary
// (apps/api-ts/src/identity/identity.types.ts) is pending|active|inactive|
// revoked -- it has no "suspended" value at all, so that branch above is
// currently unreachable via httpIdentityChecker against the real app (worth
// closing when the revocation workflow, EPIC-001 US-004, lands). "active"
// and "inactive" both fall through the switch unblocked today -- proceeding
// exactly like an unrecognized/garbage status string would, which is a gap
// but not one this bug fix's scope (the seam contract, not the status
// vocabulary) covers.
func TestLoginStatusGateFallsThroughForActiveAndInactive(t *testing.T) {
	now := time.Now().UTC()
	for _, status := range []string{"active", "inactive"} {
		svc := NewService(nil, IdentityCheckerFunc(func(string) (string, error) { return status, nil }), nil, nil)
		_, _, err := svc.Login(LoginInput{CitizenID: "c", DeviceFingerprint: "fp", IPSubnet: "s"}, now)
		if err != nil {
			t.Fatalf("status %s: err = %v, want nil (falls through to session issuance)", status, err)
		}
	}
}

// A transport/decode failure from the identity checker (e.g. httpIdentityChecker
// hitting a 5xx, a timeout, or -- BUG-002's exact failure mode -- a 404 from
// a route the caller isn't authorized to read) must fail closed, never
// silently proceed as if the citizen were active.
func TestLoginFailsClosedWhenIdentityCheckerErrors(t *testing.T) {
	now := time.Now().UTC()
	svc := NewService(nil, IdentityCheckerFunc(func(string) (string, error) { return "", errors.New("identity-service returned 404") }), nil, nil)
	_, _, err := svc.Login(LoginInput{CitizenID: "c", DeviceFingerprint: "fp", IPSubnet: "s"}, now)
	if err != ErrUnauthorized {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
}

// DP-059 refresh: rotation invalidates the old token; device mismatch
// suspends the session (DP-066); stale MFA downgrades to T1.
func TestRefreshRotationAndBinding(t *testing.T) {
	svc := testService()
	now := time.Now().UTC()
	svc.Enroll(EnrollInput{CitizenID: "c", FactorType: FactorTOTP, TOTPSecret: "s"}, now)
	_, tokens, _ := svc.Login(LoginInput{
		CitizenID: "c", DeviceFingerprint: "fp", IPSubnet: "sub",
		StepUpFactorType: FactorTOTP, StepUpProof: "123456",
	}, now)
	if tokens.AssuranceTier != TierT2 {
		t.Fatalf("tier = %q", tokens.AssuranceTier)
	}
	refreshed, err := svc.Refresh(tokens.RefreshToken, "fp", "sub", "10.0.0.2", now.Add(time.Minute))
	if err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	if _, err := svc.Refresh(tokens.RefreshToken, "fp", "sub", "10.0.0.2", now.Add(2*time.Minute)); err != ErrUnauthorized {
		t.Fatalf("reused refresh = %v, want ErrUnauthorized", err)
	}
	_ = refreshed

	// Wrong device on the live refresh token suspends the session.
	_, err = svc.Refresh(refreshed.RefreshToken, "other-fp", "sub", "10.0.0.9", now.Add(3*time.Minute))
	if err != ErrUnauthorized {
		t.Fatalf("device mismatch = %v, want ErrUnauthorized", err)
	}
	sess, err := svc.store.GetSession(tokens.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if sess.Status != SessionSuspended {
		t.Fatalf("status = %q, want suspended", sess.Status)
	}
	// Suspended sessions fail validation.
	if _, err := svc.Validate(refreshed.AccessToken, now.Add(4*time.Minute)); err != ErrUnauthorized {
		t.Fatalf("suspended validate = %v, want ErrUnauthorized", err)
	}
}

// DP-060: enrollment rules per factor type; facial needs liveness + match.
func TestEnrollValidation(t *testing.T) {
	svc := testService()
	now := time.Now().UTC()
	if _, err := svc.Enroll(EnrollInput{CitizenID: "c", FactorType: "sms"}, now); err != ErrInvalid {
		t.Fatalf("unknown factor = %v", err)
	}
	if _, err := svc.Enroll(EnrollInput{CitizenID: "c", FactorType: FactorFacial, BiometricEmbedding: "emb"}, now); err != ErrInvalid {
		t.Fatalf("facial without liveness = %v (must be rejected)", err)
	}
	f, err := svc.Enroll(EnrollInput{
		CitizenID: "c", FactorType: FactorFacial,
		BiometricEmbedding: "emb", LivenessConfirmed: true, ReferenceMatchScore: 0.97,
	}, now)
	if err != nil || f.Status != FactorActive {
		t.Fatalf("Enroll = %v, %v", f, err)
	}
	if f.BiometricEmbeddingEnc == "" || f.BiometricEmbeddingEnc == "emb" {
		t.Fatal("embedding stored in plaintext")
	}
}

// DP-061: T3 needs passkey/facial; brute force suspends.
func TestStepUpTiersAndBruteForce(t *testing.T) {
	svc := testService()
	now := time.Now().UTC()
	svc.Enroll(EnrollInput{CitizenID: "c", FactorType: FactorTOTP, TOTPSecret: "s"}, now)
	sess, _ := login(t, svc, "c")

	if _, err := svc.StepUp(StepUpInput{SessionID: sess.ID, FactorType: FactorPasskey, Proof: "x"}, now); err != ErrForbidden {
		t.Fatalf("unenrolled passkey = %v, want ErrForbidden", err)
	}
	tokens, err := svc.StepUp(StepUpInput{SessionID: sess.ID, FactorType: FactorTOTP, Proof: "123456"}, now)
	if err != nil || tokens.AssuranceTier != TierT2 {
		t.Fatalf("StepUp = %v, %v", tokens, err)
	}

	// Five bad proofs trip the anomaly suspension.
	for i := 0; i < MaxMFAFailures; i++ {
		svc.StepUp(StepUpInput{SessionID: sess.ID, FactorType: FactorTOTP, Proof: "bad"}, now.Add(time.Duration(i)*time.Second))
	}
	updated, err := svc.store.GetSession(sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Status != SessionSuspended {
		t.Fatalf("status = %q, want suspended after brute force", updated.Status)
	}
}

// DP-042 linkage: revoke-all kills every session; revoked rows are kept.
func TestRevokeAll(t *testing.T) {
	svc := testService()
	login(t, svc, "c")
	login(t, svc, "c")
	n, err := svc.RevokeAll("c", time.Now().UTC())
	if err != nil || n != 2 {
		t.Fatalf("RevokeAll = %d, %v", n, err)
	}
	sessions, err := svc.store.SessionsOf("c")
	if err != nil {
		t.Fatal(err)
	}
	if got := len(sessions); got != 2 {
		t.Fatalf("revoked rows retained: %d", got)
	}
}

// DP-067: only naturally-expired past-grace rows are purged.
func TestPurge(t *testing.T) {
	svc := testService()
	now := time.Now().UTC()
	sess, _ := login(t, svc, "c")
	if _, err := svc.store.SetStatus(sess.ID, SessionRevoked); err != nil {
		t.Fatal(err)
	}
	n, err := svc.Purge(now.Add(RefreshTTL + PurgeGrace + time.Hour))
	if err != nil || n != 0 {
		t.Fatalf("revoked rows purged: %d, %v", n, err)
	}
	sess2, _ := login(t, svc, "c2")
	_ = sess2
	n, err = svc.Purge(now)
	if err != nil || n != 0 {
		t.Fatalf("live rows purged: %d, %v", n, err)
	}
}

func TestHealthz(t *testing.T) {
	srv := httptest.NewServer(NewRouter(testService(), nil))
	defer srv.Close()
	for _, path := range []string{"/healthz", "/readyz"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s = %d", path, resp.StatusCode)
		}
	}
}

// IdentityCheckerFunc adapts a function to the seam interface.
type IdentityCheckerFunc func(citizenID string) (string, error)

func (f IdentityCheckerFunc) StatusOf(citizenID string) (string, error) {
	return f(citizenID)
}
