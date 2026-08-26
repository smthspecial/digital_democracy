package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

type handler struct {
	svc *Service
}

func newHandler(svc *Service) *handler {
	return &handler{svc: svc}
}

type createDelegationRequest struct {
	DelegatorID string    `json:"delegator_id"`
	DelegateID  string    `json:"delegate_id"`
	DomainID    string    `json:"domain_id"`
	ExpiresAt   time.Time `json:"expires_at"`
}

func (h *handler) createDelegation(w http.ResponseWriter, r *http.Request) {
	var req createDelegationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed request body")
		return
	}
	d, err := h.svc.CreateDelegation(req.DelegatorID, req.DelegateID, req.DomainID, req.ExpiresAt, time.Now())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, d)
}

// requesting_citizen_id travels in the DELETE body since it authorizes a
// state change (not just an identifier); see README for the convention.
type revokeDelegationRequest struct {
	RequestingCitizenID string `json:"requesting_citizen_id"`
}

func (h *handler) revokeDelegation(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req revokeDelegationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed request body")
		return
	}
	d, err := h.svc.RevokeDelegation(id, req.RequestingCitizenID, time.Now())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, d)
}

func (h *handler) listDelegations(w http.ResponseWriter, r *http.Request) {
	filter := ListFilter{
		DelegatorID: r.URL.Query().Get("delegator_id"),
		DelegateID:  r.URL.Query().Get("delegate_id"),
		DomainID:    r.URL.Query().Get("domain_id"),
	}
	got := h.svc.ListDelegations(filter)
	writeJSON(w, http.StatusOK, map[string]any{"delegations": got})
}

type resolveChainRequest struct {
	DelegateID string `json:"delegate_id"`
	DomainID   string `json:"domain_id"`
}

func (h *handler) resolveChain(w http.ResponseWriter, r *http.Request) {
	var req resolveChainRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "malformed request body")
		return
	}
	ids, err := h.svc.ResolveChain(req.DelegateID, req.DomainID, time.Now())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"delegator_ids": ids})
}

func (h *handler) expireDelegations(w http.ResponseWriter, r *http.Request) {
	count, err := h.svc.ExpireDelegations(time.Now())
	if err != nil {
		writeServiceError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revoked_count": count})
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeServiceError(w http.ResponseWriter, err error) {
	status, message := statusForError(err)
	writeError(w, status, message)
}

func statusForError(err error) (int, string) {
	switch {
	case errors.Is(err, ErrDelegationNotFound):
		return http.StatusNotFound, err.Error()
	case errors.Is(err, ErrNotDelegator):
		return http.StatusForbidden, err.Error()
	case errors.Is(err, ErrAlreadyRevoked):
		return http.StatusConflict, err.Error()
	case errors.Is(err, ErrSelfDelegation),
		errors.Is(err, ErrExpiryNotFuture),
		errors.Is(err, ErrNoCompetency),
		errors.Is(err, ErrCircularDelegation),
		errors.Is(err, ErrValidation):
		return http.StatusBadRequest, err.Error()
	default:
		return http.StatusInternalServerError, "internal error"
	}
}
