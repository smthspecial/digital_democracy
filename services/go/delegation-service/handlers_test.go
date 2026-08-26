package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newTestRouter(svc *Service) http.Handler {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return newRouter(logger, svc)
}

func doJSON(t *testing.T, router http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	switch b := body.(type) {
	case nil:
		reader = nil
	case string:
		reader = bytes.NewBufferString(b)
	default:
		buf, err := json.Marshal(b)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
		reader = bytes.NewBuffer(buf)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func decodeBody(t *testing.T, rec *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.NewDecoder(rec.Body).Decode(v); err != nil {
		t.Fatalf("decode response body %q: %v", rec.Body.String(), err)
	}
}

func TestHandlerCreateAndList(t *testing.T) {
	svc := NewService(NewStore(), nil, nil)
	router := newTestRouter(svc)
	expires := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)

	rec := doJSON(t, router, http.MethodPost, "/delegation/delegations", map[string]string{
		"delegator_id": "alice",
		"delegate_id":  "bob",
		"domain_id":    "healthcare",
		"expires_at":   expires,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var created Delegation
	decodeBody(t, rec, &created)
	if created.ID == "" || created.DelegatorID != "alice" || created.DelegateID != "bob" {
		t.Fatalf("unexpected created delegation: %+v", created)
	}

	rec = doJSON(t, router, http.MethodGet, "/delegation/delegations", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var listResp struct {
		Delegations []Delegation `json:"delegations"`
	}
	decodeBody(t, rec, &listResp)
	if len(listResp.Delegations) != 1 || listResp.Delegations[0].ID != created.ID {
		t.Fatalf("expected the created delegation in the list, got %+v", listResp.Delegations)
	}

	rec = doJSON(t, router, http.MethodGet, "/delegation/delegations?domain_id=transportation", nil)
	decodeBody(t, rec, &listResp)
	if len(listResp.Delegations) != 0 {
		t.Fatalf("expected no results for unrelated domain filter, got %+v", listResp.Delegations)
	}
}

func TestHandlerCreateSelfDelegationRejected(t *testing.T) {
	svc := NewService(NewStore(), nil, nil)
	router := newTestRouter(svc)
	expires := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)

	rec := doJSON(t, router, http.MethodPost, "/delegation/delegations", map[string]string{
		"delegator_id": "alice",
		"delegate_id":  "alice",
		"domain_id":    "healthcare",
		"expires_at":   expires,
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	var errBody map[string]string
	decodeBody(t, rec, &errBody)
	if errBody["error"] == "" {
		t.Fatalf("expected an error message, got %+v", errBody)
	}
}

func TestHandlerCreateNoCompetencyRejected(t *testing.T) {
	competency := newFakeCompetencyChecker() // denies everyone by default
	svc := NewService(NewStore(), competency, nil)
	router := newTestRouter(svc)
	expires := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)

	rec := doJSON(t, router, http.MethodPost, "/delegation/delegations", map[string]string{
		"delegator_id": "alice",
		"delegate_id":  "bob",
		"domain_id":    "healthcare",
		"expires_at":   expires,
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerCreateCircularRejectedDirectAndTransitive(t *testing.T) {
	svc := NewService(NewStore(), nil, nil)
	router := newTestRouter(svc)
	expires := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)

	create := func(delegator, delegate, domain string) *httptest.ResponseRecorder {
		return doJSON(t, router, http.MethodPost, "/delegation/delegations", map[string]string{
			"delegator_id": delegator,
			"delegate_id":  delegate,
			"domain_id":    domain,
			"expires_at":   expires,
		})
	}

	t.Run("direct cycle", func(t *testing.T) {
		if rec := create("A1", "B1", "d1"); rec.Code != http.StatusCreated {
			t.Fatalf("A1->B1 expected 201, got %d: %s", rec.Code, rec.Body.String())
		}
		rec := create("B1", "A1", "d1")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for direct cycle, got %d: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("transitive cycle", func(t *testing.T) {
		if rec := create("A2", "B2", "d2"); rec.Code != http.StatusCreated {
			t.Fatalf("A2->B2 expected 201: %s", rec.Body.String())
		}
		if rec := create("B2", "C2", "d2"); rec.Code != http.StatusCreated {
			t.Fatalf("B2->C2 expected 201: %s", rec.Body.String())
		}
		rec := create("C2", "A2", "d2")
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for transitive cycle, got %d: %s", rec.Code, rec.Body.String())
		}
	})
}

func TestHandlerRevokeForbiddenAndConflict(t *testing.T) {
	svc := NewService(NewStore(), nil, nil)
	router := newTestRouter(svc)
	expires := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)

	rec := doJSON(t, router, http.MethodPost, "/delegation/delegations", map[string]string{
		"delegator_id": "alice",
		"delegate_id":  "bob",
		"domain_id":    "healthcare",
		"expires_at":   expires,
	})
	var created Delegation
	decodeBody(t, rec, &created)

	rec = doJSON(t, router, http.MethodDelete, "/delegation/delegations/"+created.ID, map[string]string{
		"requesting_citizen_id": "eve",
	})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for non-owner revoke, got %d: %s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, router, http.MethodDelete, "/delegation/delegations/"+created.ID, map[string]string{
		"requesting_citizen_id": "alice",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 for owner revoke, got %d: %s", rec.Code, rec.Body.String())
	}
	var revoked Delegation
	decodeBody(t, rec, &revoked)
	if revoked.RevokedAt == nil {
		t.Fatalf("expected revoked_at to be set: %+v", revoked)
	}

	rec = doJSON(t, router, http.MethodDelete, "/delegation/delegations/"+created.ID, map[string]string{
		"requesting_citizen_id": "alice",
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409 for double revoke, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerRevokeUnknownID(t *testing.T) {
	svc := NewService(NewStore(), nil, nil)
	router := newTestRouter(svc)

	rec := doJSON(t, router, http.MethodDelete, "/delegation/delegations/does-not-exist", map[string]string{
		"requesting_citizen_id": "alice",
	})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandlerResolveMultiHop(t *testing.T) {
	svc := NewService(NewStore(), nil, nil)
	router := newTestRouter(svc)
	now := time.Now()
	future := now.Add(time.Hour).UTC().Format(time.RFC3339)

	create := func(delegator, delegate string) {
		rec := doJSON(t, router, http.MethodPost, "/delegation/delegations", map[string]string{
			"delegator_id": delegator,
			"delegate_id":  delegate,
			"domain_id":    "d",
			"expires_at":   future,
		})
		if rec.Code != http.StatusCreated {
			t.Fatalf("setup create %s->%s failed: %d %s", delegator, delegate, rec.Code, rec.Body.String())
		}
	}
	create("C3", "B3")
	create("B3", "A3")

	// D3->A3 revoked immediately, must be excluded from the resolved chain.
	rec := doJSON(t, router, http.MethodPost, "/delegation/delegations", map[string]string{
		"delegator_id": "D3",
		"delegate_id":  "A3",
		"domain_id":    "d",
		"expires_at":   future,
	})
	var toRevoke Delegation
	decodeBody(t, rec, &toRevoke)
	rec = doJSON(t, router, http.MethodDelete, "/delegation/delegations/"+toRevoke.ID, map[string]string{
		"requesting_citizen_id": "D3",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke setup failed: %d %s", rec.Code, rec.Body.String())
	}

	rec = doJSON(t, router, http.MethodPost, "/delegation/resolve", map[string]string{
		"delegate_id": "A3",
		"domain_id":   "d",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		DelegatorIDs []string `json:"delegator_ids"`
	}
	decodeBody(t, rec, &resp)

	want := map[string]bool{"B3": true, "C3": true}
	if len(resp.DelegatorIDs) != len(want) {
		t.Fatalf("got %v, want members of %v", resp.DelegatorIDs, want)
	}
	for _, id := range resp.DelegatorIDs {
		if !want[id] {
			t.Fatalf("unexpected id %q in resolved chain %v", id, resp.DelegatorIDs)
		}
	}
}

func TestHandlerExpireIdempotent(t *testing.T) {
	store := NewStore()
	svc := NewService(store, nil, nil)
	router := newTestRouter(svc)
	now := time.Now()
	store.InsertIfAcyclic(&Delegation{
		ID: "expired-1", DelegatorID: "alice", DelegateID: "bob", DomainID: "d",
		CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: now.Add(-time.Hour),
	}, now.Add(-2*time.Hour))

	rec := doJSON(t, router, http.MethodPost, "/delegation/internal/expire", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]int
	decodeBody(t, rec, &resp)
	if resp["revoked_count"] != 1 {
		t.Fatalf("expected revoked_count=1, got %+v", resp)
	}

	rec = doJSON(t, router, http.MethodPost, "/delegation/internal/expire", nil)
	decodeBody(t, rec, &resp)
	if resp["revoked_count"] != 0 {
		t.Fatalf("expected second call revoked_count=0, got %+v", resp)
	}
}

func TestHandlerMalformedJSON(t *testing.T) {
	svc := NewService(NewStore(), nil, nil)
	router := newTestRouter(svc)

	rec := doJSON(t, router, http.MethodPost, "/delegation/delegations", "{not valid json")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	var errBody map[string]string
	decodeBody(t, rec, &errBody)
	if errBody["error"] == "" {
		t.Fatalf("expected error message in body, got %+v", errBody)
	}
}

func TestHandlerHealthzStillWorksWithService(t *testing.T) {
	svc := NewService(NewStore(), nil, nil)
	router := newTestRouter(svc)
	rec := doJSON(t, router, http.MethodGet, "/healthz", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
}

func TestHandlerConcurrentCreates(t *testing.T) {
	svc := NewService(NewStore(), nil, nil)
	router := newTestRouter(svc)
	expires := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)

	done := make(chan *httptest.ResponseRecorder, 20)
	for i := 0; i < 20; i++ {
		go func(i int) {
			rec := doJSON(t, router, http.MethodPost, "/delegation/delegations", map[string]string{
				"delegator_id": fmt.Sprintf("delegator-%d", i),
				"delegate_id":  "shared-delegate",
				"domain_id":    "d",
				"expires_at":   expires,
			})
			done <- rec
		}(i)
	}
	for i := 0; i < 20; i++ {
		rec := <-done
		if rec.Code != http.StatusCreated {
			t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
		}
	}
}
