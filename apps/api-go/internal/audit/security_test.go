package audit

import (
	"encoding/json"
	"github.com/digital-democracy/api-go/internal/security"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestProtocolHTTPUsesAuthoritativeIndependentApprovals(t *testing.T) {
	actors := []string{"citizen", "auditor", "body"}
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !security.Verify(w, r, "api-go", "audit-http-test-secret", &security.ReplayStore{}) {
			return
		}
		types := []string{"citizen_supermajority", "audit_confirmation", "body_endorsement"}
		approvals := []ProtocolApproval{}
		for i, kind := range types {
			approvals = append(approvals, ProtocolApproval{Ref: kind, ApproverRef: actors[i], At: time.Now()})
		}
		json.NewEncoder(w).Encode(map[string]any{"approvals": approvals})
	}))
	defer source.Close()
	t.Setenv("GOVERNANCE_SERVICE_URL", source.URL)
	t.Setenv("INTERNAL_SERVICE_SHARED_SECRET", "audit-http-test-secret")
	srv, svc := newTestServer(t)
	malicious := postJSON(t, srv.URL+"/audit/protocol-changes", map[string]any{"change_ref": "c", "required_approval_refs": []string{"fake"}, "delay_until": time.Now().Add(-time.Hour)})
	malicious.Body.Close()
	if malicious.StatusCode != 400 {
		t.Fatal("caller controls gate policy")
	}
	response := postJSON(t, srv.URL+"/audit/protocol-changes", map[string]string{"change_ref": "c"})
	var change ProtocolChange
	decodeBody(t, response, &change)
	if change.DelayUntil.Sub(change.VisibleSince) < 24*time.Hour || len(change.RequiredApprovals) != 3 {
		t.Fatal("gate policy not server derived")
	}
	approval := postJSON(t, srv.URL+"/audit/protocol-changes/"+change.ID+"/approvals", map[string]string{"ref": "fake", "approver_ref": "forged"})
	approval.Body.Close()
	if approval.StatusCode != 403 {
		t.Fatal("self asserted approval accepted")
	}
	release := postJSON(t, srv.URL+"/audit/protocol-changes/"+change.ID+"/release", map[string]any{})
	release.Body.Close()
	if release.StatusCode != 422 {
		t.Fatalf("delay bypass: %d", release.StatusCode)
	}
	// Only this fixture advances the server's persisted review clock.
	st := svc.store.(*MemoryStore)
	st.mu.Lock()
	st.changes[change.ID].DelayUntil = time.Now().Add(-time.Second)
	st.changes[change.ID].VisibleSince = time.Now().Add(-25 * time.Hour)
	st.changes[change.ID].CreatedAt = st.changes[change.ID].VisibleSince
	st.mu.Unlock()
	actors[2] = actors[1]
	duplicate := postJSON(t, srv.URL+"/audit/protocol-changes/"+change.ID+"/release", map[string]any{})
	duplicate.Body.Close()
	if duplicate.StatusCode != 503 {
		t.Fatal("one actor supplies multiple approvals")
	}
	actors[2] = "body"
	valid := postJSON(t, srv.URL+"/audit/protocol-changes/"+change.ID+"/release", map[string]any{})
	valid.Body.Close()
	if valid.StatusCode != 200 {
		t.Fatalf("valid gate: %d", valid.StatusCode)
	}
}
