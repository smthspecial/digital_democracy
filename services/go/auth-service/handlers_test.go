package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// fakeIdentityChecker defaults to CitizenActive for any citizen not
// explicitly configured via setStatus, so tests that don't care about
// identity status don't need to set it up -- only tests exercising a
// non-active status configure it per citizen id.
type fakeIdentityChecker struct {
	mu       sync.Mutex
	statuses map[string]string
}

func newFakeIdentityChecker() *fakeIdentityChecker {
	return &fakeIdentityChecker{statuses: map[string]string{}}
}

func (f *fakeIdentityChecker) setStatus(citizenID, status string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.statuses[citizenID] = status
}

func (f *fakeIdentityChecker) CitizenStatus(citizenID string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if status, ok := f.statuses[citizenID]; ok {
		return status, nil
	}
	return CitizenActive, nil
}

func newTestAPI(t *testing.T) (http.Handler, *Service, *fakeIdentityChecker) {
	t.Helper()
	svc, _ := newTestService(t)
	identity := newFakeIdentityChecker()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return newRouterWithDeps(logger, svc, identity), svc, identity
}

func doJSON(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder, dst any) {
	t.Helper()
	if err := json.Unmarshal(rec.Body.Bytes(), dst); err != nil {
		t.Fatalf("decode response body %q: %v", rec.Body.String(), err)
	}
}

func TestHandleLoginVariants(t *testing.T) {
	h, svc, identity := newTestAPI(t)
	svc.store.CreateFactor(MFAFactor{CitizenID: "has-factors", FactorType: FactorTOTP, Status: FactorActive})
	identity.setStatus("c2", CitizenPending)
	identity.setStatus("c3", CitizenSuspended)
	identity.setStatus("c4", CitizenRevoked)

	cases := []struct {
		name       string
		body       loginRequest
		wantStatus int
	}{
		{"active no factors", loginRequest{CitizenID: "c1", CredentialValid: true, DeviceFingerprint: "fp", IPSubnet: "10.0.0.0/24"}, http.StatusOK},
		{"active with factors", loginRequest{CitizenID: "has-factors", CredentialValid: true, DeviceFingerprint: "fp", IPSubnet: "10.0.0.0/24"}, http.StatusOK},
		{"pending", loginRequest{CitizenID: "c2", CredentialValid: true, DeviceFingerprint: "fp", IPSubnet: "10.0.0.0/24"}, http.StatusForbidden},
		{"suspended", loginRequest{CitizenID: "c3", CredentialValid: true, DeviceFingerprint: "fp", IPSubnet: "10.0.0.0/24"}, http.StatusUnauthorized},
		{"revoked", loginRequest{CitizenID: "c4", CredentialValid: true, DeviceFingerprint: "fp", IPSubnet: "10.0.0.0/24"}, http.StatusUnauthorized},
		{"bad credential", loginRequest{CitizenID: "c5", CredentialValid: false, DeviceFingerprint: "fp", IPSubnet: "10.0.0.0/24"}, http.StatusUnauthorized},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := doJSON(t, h, http.MethodPost, "/auth/login", tc.body)
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d, body=%s", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if rec.Code == http.StatusOK {
				var resp loginResponse
				decodeBody(t, rec, &resp)
				if resp.AccessToken == "" || resp.RefreshToken == "" {
					t.Errorf("expected tokens in response body")
				}
			} else {
				var resp map[string]string
				decodeBody(t, rec, &resp)
				if resp["error"] == "" {
					t.Errorf("expected an error message")
				}
				// suspended and revoked must produce the identical generic message (no detail leak)
			}
		})
	}

	suspRec := doJSON(t, h, http.MethodPost, "/auth/login", loginRequest{CitizenID: "c3", CredentialValid: true, DeviceFingerprint: "fp", IPSubnet: "10.0.0.0/24"})
	revRec := doJSON(t, h, http.MethodPost, "/auth/login", loginRequest{CitizenID: "c4", CredentialValid: true, DeviceFingerprint: "fp", IPSubnet: "10.0.0.0/24"})
	var suspBody, revBody map[string]string
	decodeBody(t, suspRec, &suspBody)
	decodeBody(t, revRec, &revBody)
	if suspBody["error"] != revBody["error"] {
		t.Errorf("suspended and revoked must return identical error messages, got %q vs %q", suspBody["error"], revBody["error"])
	}
}

// TestHandleLoginIgnoresClientSuppliedStatus is the regression test for the
// fix this closes: a client spoofing citizen_status directly in the raw
// request body must not be able to log in as a suspended citizen just by
// claiming "active" -- status must always come from IdentityChecker.
func TestHandleLoginIgnoresClientSuppliedStatus(t *testing.T) {
	h, _, identity := newTestAPI(t)
	identity.setStatus("suspended-citizen", CitizenSuspended)

	req := httptest.NewRequest(http.MethodPost, "/auth/login", bytes.NewReader([]byte(
		`{"citizen_id":"suspended-citizen","citizen_status":"active","credential_valid":true,"device_fingerprint":"fp","ip_subnet":"10.0.0.0/24"}`,
	)))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (a spoofed citizen_status must not grant a session), body=%s", rec.Code, rec.Body.String())
	}
}

// TestHandleLoginNoIdentityConfiguredFailsClosed proves the fail-closed
// default: with no real IdentityChecker wired in, login must be denied
// rather than treating every citizen as active.
func TestHandleLoginNoIdentityConfiguredFailsClosed(t *testing.T) {
	svc, _ := newTestService(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	h := newRouter(logger, svc) // no identity dep supplied -> noopIdentityChecker

	rec := doJSON(t, h, http.MethodPost, "/auth/login", loginRequest{
		CitizenID: "citizen-1", CredentialValid: true, DeviceFingerprint: "fp", IPSubnet: "10.0.0.0/24",
	})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (unconfigured identity check must fail closed), body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandleMalformedJSON(t *testing.T) {
	h, _, _ := newTestAPI(t)
	req := httptest.NewRequest(http.MethodPost, "/auth/login", bytes.NewReader([]byte("{not-json")))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestHandleEnrollAndStepUpFullFlowTOTP(t *testing.T) {
	h, _, _ := newTestAPI(t)

	loginRec := doJSON(t, h, http.MethodPost, "/auth/login", loginRequest{CitizenID: "c1", CredentialValid: true, DeviceFingerprint: "fp", IPSubnet: "10.0.0.0/24"})
	var loginResp loginResponse
	decodeBody(t, loginRec, &loginResp)

	secret := totpGenerateSecret()
	code, err := totpCode(secret, time.Now())
	if err != nil {
		t.Fatalf("totpCode: %v", err)
	}
	enrollRec := doJSON(t, h, http.MethodPost, "/auth/factors", enrollFactorRequest{
		CitizenID: "c1", SessionID: loginResp.ID, FactorType: "totp", TOTPSecret: secret, TOTPCode: code,
	})
	if enrollRec.Code != http.StatusOK {
		t.Fatalf("enroll status = %d, body=%s", enrollRec.Code, enrollRec.Body.String())
	}

	code2, err := totpCode(secret, time.Now())
	if err != nil {
		t.Fatalf("totpCode: %v", err)
	}
	stepUpRec := doJSON(t, h, http.MethodPost, "/auth/stepup", stepUpRequest{
		SessionID: loginResp.ID, Tier: "T2", FactorType: "totp", TOTPCode: code2,
	})
	if stepUpRec.Code != http.StatusOK {
		t.Fatalf("stepup status = %d, body=%s", stepUpRec.Code, stepUpRec.Body.String())
	}
	var stepUpResp Session
	decodeBody(t, stepUpRec, &stepUpResp)
	if stepUpResp.AssuranceTier != TierT2 {
		t.Fatalf("expected T2, got %s", stepUpResp.AssuranceTier)
	}
	if stepUpResp.AccessToken == "" {
		t.Errorf("expected a reissued access token in the stepup response")
	}
}

func TestHandleEnrollAndStepUpFullFlowPasskey(t *testing.T) {
	h, _, _ := newTestAPI(t)

	loginRec := doJSON(t, h, http.MethodPost, "/auth/login", loginRequest{CitizenID: "c1", CredentialValid: true, DeviceFingerprint: "fp", IPSubnet: "10.0.0.0/24"})
	var loginResp loginResponse
	decodeBody(t, loginRec, &loginResp)

	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	pubDER, err := marshalECDSAPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatalf("marshalECDSAPublicKey: %v", err)
	}
	enrollChallenge := generatePasskeyChallenge()
	enrollHash := sha256.Sum256(enrollChallenge)
	enrollSig, err := ecdsa.SignASN1(rand.Reader, priv, enrollHash[:])
	if err != nil {
		t.Fatalf("SignASN1: %v", err)
	}

	enrollRec := doJSON(t, h, http.MethodPost, "/auth/factors", enrollFactorRequest{
		CitizenID: "c1", SessionID: loginResp.ID, FactorType: "passkey",
		PasskeyCredentialID: "cred-1", PasskeyPublicKey: pubDER,
		PasskeyChallenge: enrollChallenge, PasskeySignature: enrollSig,
	})
	if enrollRec.Code != http.StatusOK {
		t.Fatalf("enroll status = %d, body=%s", enrollRec.Code, enrollRec.Body.String())
	}

	stepChallenge := generatePasskeyChallenge()
	stepHash := sha256.Sum256(stepChallenge)
	stepSig, err := ecdsa.SignASN1(rand.Reader, priv, stepHash[:])
	if err != nil {
		t.Fatalf("SignASN1: %v", err)
	}
	stepUpRec := doJSON(t, h, http.MethodPost, "/auth/stepup", stepUpRequest{
		SessionID: loginResp.ID, Tier: "T3", FactorType: "passkey",
		PasskeyChallenge: stepChallenge, PasskeySignature: stepSig,
	})
	if stepUpRec.Code != http.StatusOK {
		t.Fatalf("stepup status = %d, body=%s", stepUpRec.Code, stepUpRec.Body.String())
	}
	var stepUpResp Session
	decodeBody(t, stepUpRec, &stepUpResp)
	if stepUpResp.AssuranceTier != TierT3 {
		t.Fatalf("expected T3, got %s", stepUpResp.AssuranceTier)
	}
}

func TestHandleEnrollAndStepUpFullFlowFacial(t *testing.T) {
	h, _, _ := newTestAPI(t)

	loginRec := doJSON(t, h, http.MethodPost, "/auth/login", loginRequest{CitizenID: "c1", CredentialValid: true, DeviceFingerprint: "fp", IPSubnet: "10.0.0.0/24"})
	var loginResp loginResponse
	decodeBody(t, loginRec, &loginResp)

	ref := []float64{1, 0, 0, 0}
	enrollRec := doJSON(t, h, http.MethodPost, "/auth/factors", enrollFactorRequest{
		CitizenID: "c1", SessionID: loginResp.ID, FactorType: "facial",
		Embedding: ref, ReferenceEmbedding: ref, Liveness: true,
	})
	if enrollRec.Code != http.StatusOK {
		t.Fatalf("enroll status = %d, body=%s", enrollRec.Code, enrollRec.Body.String())
	}

	stepUpRec := doJSON(t, h, http.MethodPost, "/auth/stepup", stepUpRequest{
		SessionID: loginResp.ID, Tier: "T3", FactorType: "facial",
		Embedding: ref, Liveness: true,
	})
	if stepUpRec.Code != http.StatusOK {
		t.Fatalf("stepup status = %d, body=%s", stepUpRec.Code, stepUpRec.Body.String())
	}
	var stepUpResp Session
	decodeBody(t, stepUpRec, &stepUpResp)
	if stepUpResp.AssuranceTier != TierT3 {
		t.Fatalf("expected T3, got %s", stepUpResp.AssuranceTier)
	}

	// liveness=false must be rejected outright even though the embedding matches
	noLivenessRec := doJSON(t, h, http.MethodPost, "/auth/stepup", stepUpRequest{
		SessionID: loginResp.ID, Tier: "T3", FactorType: "facial",
		Embedding: ref, Liveness: false,
	})
	if noLivenessRec.Code == http.StatusOK {
		t.Fatalf("expected liveness=false to be rejected")
	}
}

func TestHandleRefreshFlow(t *testing.T) {
	h, _, _ := newTestAPI(t)

	loginRec := doJSON(t, h, http.MethodPost, "/auth/login", loginRequest{CitizenID: "c1", CredentialValid: true, DeviceFingerprint: "fp-1", IPSubnet: "10.0.0.0/24"})
	var loginResp loginResponse
	decodeBody(t, loginRec, &loginResp)

	t.Run("happy path", func(t *testing.T) {
		rec := doJSON(t, h, http.MethodPost, "/auth/refresh", refreshRequest{RefreshToken: loginResp.RefreshToken, DeviceFingerprint: "fp-1", IPSubnet: "10.0.0.0/24"})
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
		}
		var resp Session
		decodeBody(t, rec, &resp)
		if resp.AccessToken == "" || resp.RefreshToken == "" {
			t.Errorf("expected new tokens in refresh response")
		}

		reuseRec := doJSON(t, h, http.MethodPost, "/auth/refresh", refreshRequest{RefreshToken: loginResp.RefreshToken, DeviceFingerprint: "fp-1", IPSubnet: "10.0.0.0/24"})
		if reuseRec.Code != http.StatusUnauthorized {
			t.Fatalf("expected reuse of rotated-away token to be rejected, got %d", reuseRec.Code)
		}
	})

	t.Run("device mismatch anomaly", func(t *testing.T) {
		login2 := doJSON(t, h, http.MethodPost, "/auth/login", loginRequest{CitizenID: "c2", CredentialValid: true, DeviceFingerprint: "fp-2", IPSubnet: "10.0.0.0/24"})
		var l2 loginResponse
		decodeBody(t, login2, &l2)

		rec := doJSON(t, h, http.MethodPost, "/auth/refresh", refreshRequest{RefreshToken: l2.RefreshToken, DeviceFingerprint: "different-fp", IPSubnet: "10.0.0.0/24"})
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})
}

func TestHandleStepUpBruteForceLockout(t *testing.T) {
	h, svc, _ := newTestAPI(t)
	svc.store.CreateFactor(MFAFactor{CitizenID: "c1", FactorType: FactorTOTP, Status: FactorActive, TOTPSecretEnc: mustEncrypt(t, svc, "wrong-secret-doesnt-matter")})
	sess := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive})

	var lastRec *httptest.ResponseRecorder
	for i := 0; i < 5; i++ {
		lastRec = doJSON(t, h, http.MethodPost, "/auth/stepup", stepUpRequest{SessionID: sess.ID, Tier: "T2", FactorType: "totp", TOTPCode: "000000"})
		if lastRec.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: status = %d, want 401", i, lastRec.Code)
		}
	}
	updated, _ := svc.store.GetSession(sess.ID)
	if updated.Status != SessionSuspended {
		t.Fatalf("expected session suspended after 5 failed stepup attempts, got %s", updated.Status)
	}
}

func mustEncrypt(t *testing.T, svc *Service, plaintext string) []byte {
	t.Helper()
	ct, err := svc.enc.encrypt([]byte(plaintext))
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	return ct
}

func TestHandleLogout(t *testing.T) {
	h, svc, _ := newTestAPI(t)
	sess := svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive, RefreshTokenHash: "rt"})

	rec := doJSON(t, h, http.MethodPost, "/auth/logout", logoutRequest{SessionID: sess.ID})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	updated, _ := svc.store.GetSession(sess.ID)
	if updated.Status != SessionRevoked {
		t.Errorf("expected revoked, got %s", updated.Status)
	}

	notFoundRec := doJSON(t, h, http.MethodPost, "/auth/logout", logoutRequest{SessionID: "no-such-session"})
	if notFoundRec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", notFoundRec.Code)
	}
}

func TestHandleInternalValidate(t *testing.T) {
	h, svc, _ := newTestAPI(t)
	plain, hash, _ := generateTokenPair()
	svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive, AccessTokenHash: hash, ExpiresAt: time.Now().Add(time.Hour)})

	rec := doJSON(t, h, http.MethodPost, "/auth/internal/validate", validateTokenRequest{AccessToken: plain})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}

	badRec := doJSON(t, h, http.MethodPost, "/auth/internal/validate", validateTokenRequest{AccessToken: "garbage"})
	if badRec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", badRec.Code)
	}
}

func TestHandleInternalRevokeAll(t *testing.T) {
	h, svc, _ := newTestAPI(t)
	svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive})
	svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive})

	rec := doJSON(t, h, http.MethodPost, "/auth/internal/revoke-all/c1", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var resp map[string]int
	decodeBody(t, rec, &resp)
	if resp["count"] != 2 {
		t.Fatalf("count = %d, want 2", resp["count"])
	}
}

func TestHandleInternalPurgeSessions(t *testing.T) {
	h, svc, _ := newTestAPI(t)
	svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionActive, ExpiresAt: time.Now().Add(-48 * time.Hour)})
	svc.store.CreateSession(Session{CitizenID: "c1", Status: SessionRevoked, ExpiresAt: time.Now().Add(-1000 * time.Hour)})

	rec := doJSON(t, h, http.MethodPost, "/auth/internal/purge-sessions", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var resp map[string]int
	decodeBody(t, rec, &resp)
	if resp["count"] != 1 {
		t.Fatalf("count = %d, want 1", resp["count"])
	}
}
