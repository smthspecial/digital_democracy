package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newTestRouter() http.Handler {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := NewService(NewStore())
	return newRouterWithService(logger, svc)
}

func doJSON(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("failed to marshal request body: %v", err)
		}
		reader = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHandlersAppendAndListLogRoundtrip(t *testing.T) {
	h := newTestRouter()

	rec := doJSON(t, h, http.MethodPost, "/audit/log", map[string]any{
		"action_type":     "system_update",
		"actor_ref":       "system:test",
		"payload":         map[string]any{"detail": "boot"},
		"idempotency_key": "key-1",
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var created AuditLogEntry
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if created.ID == "" {
		t.Fatalf("expected a generated id in response")
	}

	rec2 := doJSON(t, h, http.MethodGet, "/audit/log", nil)
	if rec2.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec2.Code, rec2.Body.String())
	}
	var listBody struct {
		Entries []AuditLogEntry `json:"entries"`
	}
	if err := json.Unmarshal(rec2.Body.Bytes(), &listBody); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if len(listBody.Entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(listBody.Entries))
	}
}

func TestHandlersAppendIdempotencyDedup(t *testing.T) {
	h := newTestRouter()
	body := map[string]any{
		"action_type":     "admin_action",
		"actor_ref":       "role:admin",
		"payload":         map[string]any{"a": 1},
		"idempotency_key": "dedupe-me",
	}

	rec1 := doJSON(t, h, http.MethodPost, "/audit/log", body)
	rec2 := doJSON(t, h, http.MethodPost, "/audit/log", body)

	var e1, e2 AuditLogEntry
	json.Unmarshal(rec1.Body.Bytes(), &e1)
	json.Unmarshal(rec2.Body.Bytes(), &e2)
	if e1.ID != e2.ID {
		t.Fatalf("expected same entry id for repeated idempotency key, got %q vs %q", e1.ID, e2.ID)
	}

	rec3 := doJSON(t, h, http.MethodGet, "/audit/log", nil)
	var listBody struct {
		Entries []AuditLogEntry `json:"entries"`
	}
	json.Unmarshal(rec3.Body.Bytes(), &listBody)
	if len(listBody.Entries) != 1 {
		t.Fatalf("expected exactly 1 stored entry after dedup, got %d", len(listBody.Entries))
	}
}

func TestHandlersVerifyEndpointOnCleanChain(t *testing.T) {
	h := newTestRouter()
	doJSON(t, h, http.MethodPost, "/audit/log", map[string]any{
		"action_type": "system_update",
		"actor_ref":   "system:test",
		"payload":     map[string]any{"x": 1},
	})

	rec := doJSON(t, h, http.MethodGet, "/audit/log/verify", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Valid    bool    `json:"valid"`
		BrokenAt *string `json:"broken_at"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if !body.Valid {
		t.Fatalf("expected valid=true on a clean chain")
	}
	if body.BrokenAt != nil {
		t.Fatalf("expected broken_at=null, got %v", *body.BrokenAt)
	}
}

func TestHandlersConstitutionalReviewBlockedAndCleared(t *testing.T) {
	h := newTestRouter()

	rec := doJSON(t, h, http.MethodPost, "/audit/rights", map[string]any{
		"name":        "freedom of speech",
		"description": "d",
		"protected":   true,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	blockedRec := doJSON(t, h, http.MethodPost, "/audit/proposals/prop-1/constitutional-review", map[string]any{
		"change_summary": "This limits freedom of speech directly",
	})
	if blockedRec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", blockedRec.Code, blockedRec.Body.String())
	}
	var blockedBody struct {
		Blocked bool                   `json:"blocked"`
		Reviews []ConstitutionalReview `json:"reviews"`
	}
	if err := json.Unmarshal(blockedRec.Body.Bytes(), &blockedBody); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if !blockedBody.Blocked {
		t.Fatalf("expected blocked=true")
	}

	clearedRec := doJSON(t, h, http.MethodPost, "/audit/proposals/prop-2/constitutional-review", map[string]any{
		"change_summary": "This funds a new bridge",
	})
	var clearedBody struct {
		Blocked bool `json:"blocked"`
	}
	json.Unmarshal(clearedRec.Body.Bytes(), &clearedBody)
	if clearedBody.Blocked {
		t.Fatalf("expected blocked=false for non-matching change summary")
	}
}

func TestHandlersGateReleasedAndBlocked(t *testing.T) {
	h := newTestRouter()

	rec := doJSON(t, h, http.MethodPost, "/audit/protocol-changes/gate", map[string]any{
		"required_approval_types": []string{"a", "b"},
		"obtained_approval_types": []string{"b", "a"},
		"delay_elapsed":           true,
		"publicly_visible":        true,
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Released bool   `json:"released"`
		Reason   string `json:"reason"`
	}
	json.Unmarshal(rec.Body.Bytes(), &body)
	if !body.Released {
		t.Fatalf("expected released=true, reason=%q", body.Reason)
	}

	rec2 := doJSON(t, h, http.MethodPost, "/audit/protocol-changes/gate", map[string]any{
		"required_approval_types": []string{"a", "b"},
		"obtained_approval_types": []string{"a"},
		"delay_elapsed":           true,
		"publicly_visible":        true,
	})
	var body2 struct {
		Released bool   `json:"released"`
		Reason   string `json:"reason"`
	}
	json.Unmarshal(rec2.Body.Bytes(), &body2)
	if body2.Released {
		t.Fatalf("expected released=false when an approval is missing")
	}
	if body2.Reason == "" {
		t.Fatalf("expected a reason to be given")
	}
}

func TestHandlersMalformedJSONReturns400(t *testing.T) {
	h := newTestRouter()
	req := httptest.NewRequest(http.MethodPost, "/audit/log", bytes.NewReader([]byte("{not json")))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("failed to decode error response: %v", err)
	}
	if body["error"] == "" {
		t.Fatalf("expected an error message in response")
	}
}

func TestHandlersAppendMissingActorRefReturns400(t *testing.T) {
	h := newTestRouter()
	rec := doJSON(t, h, http.MethodPost, "/audit/log", map[string]any{
		"action_type": "system_update",
		"payload":     map[string]any{},
	})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestHandlersListRights(t *testing.T) {
	h := newTestRouter()
	doJSON(t, h, http.MethodPost, "/audit/rights", map[string]any{"name": "right-a", "description": "d", "protected": false})
	doJSON(t, h, http.MethodPost, "/audit/rights", map[string]any{"name": "right-b", "description": "d", "protected": true})

	rec := doJSON(t, h, http.MethodGet, "/audit/rights", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Rights []ConstitutionalRight `json:"rights"`
	}
	json.Unmarshal(rec.Body.Bytes(), &body)
	if len(body.Rights) != 2 {
		t.Fatalf("expected 2 rights, got %d", len(body.Rights))
	}
}

func TestHandlersListLogFilterByActionType(t *testing.T) {
	h := newTestRouter()
	doJSON(t, h, http.MethodPost, "/audit/log", map[string]any{"action_type": "system_update", "actor_ref": "a", "payload": 1})
	doJSON(t, h, http.MethodPost, "/audit/log", map[string]any{"action_type": "rule_change", "actor_ref": "b", "payload": 2})

	rec := doJSON(t, h, http.MethodGet, "/audit/log?action_type=rule_change", nil)
	var body struct {
		Entries []AuditLogEntry `json:"entries"`
	}
	json.Unmarshal(rec.Body.Bytes(), &body)
	if len(body.Entries) != 1 {
		t.Fatalf("expected 1 filtered entry, got %d", len(body.Entries))
	}
	if body.Entries[0].ActionType != ActionRuleChange {
		t.Fatalf("expected rule_change entry, got %q", body.Entries[0].ActionType)
	}
}
