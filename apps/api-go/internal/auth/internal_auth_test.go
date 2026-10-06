package auth

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestRevokeAllRequiresSignedIdentityServiceRequest(t *testing.T) {
	svc := testService()
	_, tokens := login(t, svc, "citizen-1")
	router := NewRouter(svc, nil, "test-shared-secret")
	body := []byte(`{"citizen_id":"citizen-1"}`)

	public := httptest.NewRequest(http.MethodPost, "/auth/revoke-all", bytes.NewReader(body))
	publicResult := httptest.NewRecorder()
	router.ServeHTTP(publicResult, public)
	if publicResult.Code != http.StatusUnauthorized {
		t.Fatalf("public revoke-all = %d, want %d", publicResult.Code, http.StatusUnauthorized)
	}

	request := signedInternalRequest(t, http.MethodPost, "/auth/revoke-all", body, "api-ts", "test-shared-secret", time.Now().UTC())
	result := httptest.NewRecorder()
	router.ServeHTTP(result, request)
	if result.Code != http.StatusOK {
		t.Fatalf("signed revoke-all = %d, want %d: %s", result.Code, http.StatusOK, result.Body.String())
	}
	if _, err := svc.Validate(tokens.AccessToken, time.Now().UTC()); err != ErrUnauthorized {
		t.Fatalf("session after revoke-all = %v, want %v", err, ErrUnauthorized)
	}
}

func TestRevokeAllRejectsExpiredOrWrongServiceSignature(t *testing.T) {
	router := NewRouter(testService(), nil, "test-shared-secret")
	body := []byte(`{"citizen_id":"citizen-1"}`)
	for _, tc := range []struct {
		name    string
		service string
		issued  time.Time
	}{
		{name: "expired", service: "api-ts", issued: time.Now().UTC().Add(-internalRequestMaxAge - time.Second)},
		{name: "wrong service", service: "other", issued: time.Now().UTC()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := signedInternalRequest(t, http.MethodPost, "/auth/revoke-all", body, tc.service, "test-shared-secret", tc.issued)
			result := httptest.NewRecorder()
			router.ServeHTTP(result, request)
			if result.Code != http.StatusUnauthorized {
				t.Fatalf("revoke-all = %d, want %d", result.Code, http.StatusUnauthorized)
			}
		})
	}
}

func signedInternalRequest(t *testing.T, method, path string, body []byte, service, secret string, issuedAt time.Time) *http.Request {
	t.Helper()
	timestamp := strconv.FormatInt(issuedAt.Unix(), 10)
	bodyHash := sha256.Sum256(body)
	payload := method + "\n" + path + "\n" + timestamp + "\n" + hex.EncodeToString(bodyHash[:])
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(payload))
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.Header.Set("X-DD-Service", service)
	request.Header.Set("X-DD-Timestamp", timestamp)
	request.Header.Set("X-DD-Signature", hex.EncodeToString(mac.Sum(nil)))
	return request
}
