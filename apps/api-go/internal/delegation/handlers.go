package delegation

import (
	"encoding/json"
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
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "invalid_request", "message": "malformed JSON body"}})
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
	// The caller's citizen id arrives from the gateway after token
	// validation (X-Citizen-ID); empty means "already authorized upstream".
	d, err := h.svc.Revoke(r.PathValue("id"), r.Header.Get("X-Citizen-ID"), time.Now().UTC())
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
