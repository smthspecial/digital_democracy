package delegation

import (
	"bytes"
	"encoding/json"
	"github.com/digital-democracy/api-go/internal/security"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHTTPDelegationOwnership(t *testing.T) {
	svc := testService()
	access := &security.Access{Validate: func(token string) (string, string, error) { return token, "T2", nil }}
	router := NewRouter(svc, nil, access)
	call := func(method, path, bearer string, body any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(method, path, bytes.NewReader(raw))
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		req.Header.Set("X-Citizen-ID", "owner")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}
	body := map[string]any{"delegator_id": "owner", "delegate_id": "delegate", "domain_id": "domain", "expires_at": time.Now().Add(time.Hour)}
	if got := call("POST", "/delegation/delegations", "", body).Code; got != 401 {
		t.Fatalf("anonymous create: %d", got)
	}
	if got := call("POST", "/delegation/delegations", "other", body).Code; got != 403 {
		t.Fatalf("forged owner: %d", got)
	}
	result := call("POST", "/delegation/delegations", "owner", body)
	if result.Code != 201 {
		t.Fatalf("owner create: %d", result.Code)
	}
	var d Delegation
	if err := json.Unmarshal(result.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if got := call("DELETE", "/delegation/delegations/"+d.ID, "", nil).Code; got != 401 {
		t.Fatalf("anonymous revoke: %d", got)
	}
	if got := call("DELETE", "/delegation/delegations/"+d.ID, "other", nil).Code; got != 400 {
		t.Fatalf("wrong owner: %d", got)
	}
	if got := call("DELETE", "/delegation/delegations/"+d.ID, "owner", nil).Code; got != 200 {
		t.Fatalf("owner revoke: %d", got)
	}
}

func TestMissingCompetencyFailsClosed(t *testing.T) {
	svc := NewService(nil, nil, nil)
	_, err := svc.Create(CreateInput{DelegatorID: "a", DelegateID: "b", DomainID: "d", ExpiresAt: time.Now().Add(time.Hour)}, time.Now())
	if err != ErrInvalid {
		t.Fatalf("missing competency check accepted delegation: %v", err)
	}
}
