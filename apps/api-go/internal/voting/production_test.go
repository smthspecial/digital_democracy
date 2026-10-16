package voting

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestProductionCryptoGate(t *testing.T) {
	svc := NewService(nil, nil, nil)
	svc.BlockUnreviewedProductionCrypto()
	operations := []func() error{
		func() error { _, err := svc.TryOpen("session", time.Now()); return err },
		func() error { _, err := svc.IssueTokens("session", []string{"citizen"}); return err },
		func() error { _, err := svc.CastBallot("session", "token", "blind", "option", "citizen"); return err },
		func() error { _, err := svc.Tally("session"); return err },
		func() error { _, err := svc.Certify("session"); return err },
	}
	for i, operation := range operations {
		if err := operation(); !errors.Is(err, ErrProductionCryptoUnavailable) {
			t.Fatalf("operation %d bypassed production crypto gate: %v", i, err)
		}
	}
	// A proof verifier is never called in production while the gate is active.
	handler := &Handler{svc: svc}
	response := httptest.NewRecorder()
	handler.castBallot(response, httptest.NewRequest(http.MethodPost, "/voting/ballots", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("cast status %d", response.Code)
	}
}
