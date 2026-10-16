package delegation

import (
	"encoding/json"
	"errors"
	"github.com/digital-democracy/api-go/internal/security"
	"io"
	"net/http"
	"time"
)

// AUTH-010: delegation:create → T2, delegation:revoke (own) → T2. Tier
// enforcement happens in auth-service; handlers validate scope (own) and
// payload shape only.

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	code, status := "internal", http.StatusInternalServerError
	switch err {
	case ErrNotFound:
		code, status = "not_found", http.StatusNotFound
	case ErrConflict:
		code, status = "conflict", http.StatusConflict
	case ErrInvalid:
		code, status = "invalid_request", http.StatusBadRequest
	}
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": err.Error()}})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	defer r.Body.Close()
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(v); err != nil {
		var sizeError *http.MaxBytesError
		if errors.As(err, &sizeError) {
			security.Error(w, 413, "payload_too_large")
			return false
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "invalid_request", "message": "malformed JSON body"}})
		return false
	}
	if decoder.Decode(new(any)) != io.EOF {
		security.Error(w, 400, "invalid_request")
		return false
	}
	return true
}

type Handler struct{ svc *Service }

func (h *Handler) create(w http.ResponseWriter, r *http.Request) {
	var in struct {
		DelegatorID string    `json:"delegator_id"`
		DelegateID  string    `json:"delegate_id"`
		DomainID    string    `json:"domain_id"`
		ExpiresAt   time.Time `json:"expires_at"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.DelegatorID != security.CitizenID(r) {
		security.Error(w, 403, "forbidden")
		return
	}
	d, err := h.svc.Create(CreateInput(in), time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, d)
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	delegations, err := h.svc.store.List(q.Get("delegator_id"), q.Get("delegate_id"), q.Get("domain_id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	if len(delegations) > 1000 {
		delegations = delegations[:1000]
	}
	writeJSON(w, http.StatusOK, map[string]any{"delegations": delegations})
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	d, err := h.svc.store.Get(r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (h *Handler) revoke(w http.ResponseWriter, r *http.Request) {
	// Ownership uses only the validated citizen context.
	d, err := h.svc.Revoke(r.PathValue("id"), security.CitizenID(r), time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

// resolve serves DP-041 for voting-service: the forward chain for a citizen
// in a domain (voting-service may pass session_id for tracing; resolution is
// domain-scoped per FR-056).
func (h *Handler) resolve(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	chain, err := h.svc.ResolveChain(q.Get("citizen_id"), q.Get("domain_id"), time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	if chain == nil {
		chain = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"citizen_id": q.Get("citizen_id"),
		"domain_id":  q.Get("domain_id"),
		"delegators": chain,
	})
}

func (h *Handler) expire(w http.ResponseWriter, r *http.Request) {
	expired, err := h.svc.ExpireDue(time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"expired": expired})
}
