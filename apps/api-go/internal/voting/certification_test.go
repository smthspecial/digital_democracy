package voting

import (
	"github.com/digital-democracy/api-go/internal/security"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

type retryingSink struct {
	calls       int
	unavailable bool
}

func (s *retryingSink) Completed(string) error {
	s.calls++
	if s.unavailable {
		return ErrGovernanceUnavailable
	}
	return nil
}

func TestCertificationCompletionSurvivesOutage(t *testing.T) {
	store := NewStore()
	svc := NewService(store, nil, nil)
	session := testSession(t, svc)
	openTestSession(t, svc, session)
	if _, err := store.UpdateSessionStatus(session.ID, SessionClosed); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetTally(session.ID, &TallyResult{SessionID: session.ID, TotalBallots: 1, Winner: "winner", Decided: true}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.IssueToken(session.ID, "citizen"); err != nil {
		t.Fatal(err)
	}
	sink := &retryingSink{unavailable: true}
	svc.SetCertificationSink(sink)
	if _, err := svc.Certify(session.ID); err != ErrGovernanceUnavailable {
		t.Fatalf("want retryable completion error, got %v", err)
	}
	persisted, _ := store.GetSession(session.ID)
	if persisted.Status != SessionCertified {
		t.Fatal("outage lost the certified decision")
	}
	sink.unavailable = false
	// Reconstruct the service around the existing store, as after a restart.
	restarted := NewService(store, nil, nil)
	restarted.SetCertificationSink(sink)
	if err := restarted.ReconcileCertified(); err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.Certify(session.ID); err != nil {
		t.Fatal(err)
	}
	if sink.calls != 3 {
		t.Fatalf("want original, recovery and exact retry; got %d", sink.calls)
	}
	restarted.BlockUnreviewedProductionCrypto()
	if err := restarted.ReconcileCertified(); err != nil {
		t.Fatal(err)
	}
	if sink.calls != 3 {
		t.Fatal("production gate allowed fixture reconciliation")
	}
}

func TestCertificationNotificationUsesSignedServiceBoundary(t *testing.T) {
	replays := &security.ReplayStore{}
	const secret = "synthetic-certification-service-secret"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/journey/sessions/session/reconcile" {
			t.Error("wrong notification target")
		}
		if !security.Verify(w, r, "api-go", secret, replays) {
			t.Error("unsigned notification")
			return
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "{}" {
			t.Error("notification must not supply its own result")
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()
	if err := NewHTTPCertificationSink(server.URL, secret).Completed("session"); err != nil {
		t.Fatal(err)
	}
	if err := NewHTTPCertificationSink("", secret).Completed("session"); err != ErrGovernanceUnavailable {
		t.Fatal("missing endpoint did not fail closed")
	}
}
