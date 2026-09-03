package main

// Exercises httpIdentityChecker against a minimal stand-in for
// identity-service's real wire contract (SRV-001's
// GET /identity/citizens/:id), the Go-side sibling of identity-service's
// createHttpSessionRevoker/createHttpApprovalGate tests. ARCH-010 HP-1,
// EC-3, EC-17.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHttpIdentityCheckerReturnsResolvedStatus(t *testing.T) {
	var receivedPath string
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"id": "citizen-1", "status": "active"})
	}))
	defer stub.Close()

	checker := newHTTPIdentityChecker(stub.URL)
	status, err := checker.CitizenStatus("citizen-1")
	if err != nil {
		t.Fatalf("CitizenStatus returned error: %v", err)
	}
	if status != CitizenActive {
		t.Fatalf("status = %q, want %q", status, CitizenActive)
	}
	if receivedPath != "/identity/citizens/citizen-1" {
		t.Fatalf("path = %q, want /identity/citizens/citizen-1", receivedPath)
	}
}

func TestHttpIdentityCheckerURLEscapesCitizenID(t *testing.T) {
	var receivedPath string
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "active"})
	}))
	defer stub.Close()

	checker := newHTTPIdentityChecker(stub.URL)
	if _, err := checker.CitizenStatus("citizen with spaces"); err != nil {
		t.Fatalf("CitizenStatus returned error: %v", err)
	}
	// r.URL.Path is the decoded form; a correctly escaped request round-trips
	// back to the original id server-side.
	if receivedPath != "/identity/citizens/citizen with spaces" {
		t.Fatalf("path = %q, want the citizen id to round-trip through escaping", receivedPath)
	}
}

// TestHttpIdentityCheckerFailsClosedOnNon200 is ARCH-010 EC-3/EC-17's
// contract at the seam level: a lookup that doesn't resolve to a 200 (e.g.
// unknown citizen) must not be silently treated as active by the caller --
// it returns an error, and handleLogin's caller-side handling (already
// regression-tested in handlers_test.go) then denies the login rather than
// defaulting to any particular status.
func TestHttpIdentityCheckerFailsClosedOnNon200(t *testing.T) {
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer stub.Close()

	checker := newHTTPIdentityChecker(stub.URL)
	if _, err := checker.CitizenStatus("unknown-citizen"); err == nil {
		t.Fatalf("expected an error for a non-200 response, got nil")
	}
}

// TestHttpIdentityCheckerErrorsWhenUnreachable is ARCH-010 EC-17's seam-level
// contract: identity-service being unreachable must surface as an error, not
// silently resolve to any citizen_status.
func TestHttpIdentityCheckerErrorsWhenUnreachable(t *testing.T) {
	checker := newHTTPIdentityChecker("http://127.0.0.1:1")
	if _, err := checker.CitizenStatus("citizen-1"); err == nil {
		t.Fatalf("expected an error when identity-service is unreachable, got nil")
	}
}
