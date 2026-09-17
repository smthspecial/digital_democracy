package audit

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/digital-democracy/api-go/internal/metrics"
)

// AUTH-010: audit_log:read → T1-public (unauthenticated). Writes are
// worker/system-only: direct POST /audit/log accepts the internal
// DP-036 shape; service identity is enforced by the mesh (AUTH-012), not by
// these handlers.

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
	case ErrInvalid:
		code, status = "invalid_request", http.StatusBadRequest
	case ErrConflict:
		code, status = "conflict", http.StatusConflict
	default:
		var ise *InvalidStateError
		if errors.As(err, &ise) {
			code, status = "invalid_state", http.StatusUnprocessableEntity
		}
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

func (h *Handler) append(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ActionType     string `json:"action_type"`
		ActorRef       string `json:"actor_ref"`
		Payload        string `json:"payload"`
		IdempotencyKey string `json:"idempotency_key,omitempty"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	e, err := h.svc.Append(in.ActionType, in.ActorRef, in.Payload, in.IdempotencyKey)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, e)
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	limit := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 0 {
			writeErr(w, ErrInvalid)
			return
		}
		limit = n
	}
	actionType := r.URL.Query().Get("action_type")
	if actionType != "" && !validAction(actionType) {
		writeErr(w, ErrInvalid)
		return
	}
	fetchLimit := limit
	if actionType != "" {
		fetchLimit = 0
	}
	entries, err := h.svc.store.ListEntries(fetchLimit)
	if err != nil {
		writeErr(w, err)
		return
	}
	if actionType != "" {
		filtered := make([]*AuditEntry, 0, len(entries))
		for _, e := range entries {
			if e.ActionType == actionType {
				filtered = append(filtered, e)
			}
			if limit > 0 && len(filtered) == limit {
				break
			}
		}
		entries = filtered
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

func (h *Handler) get(w http.ResponseWriter, r *http.Request) {
	e, err := h.svc.store.GetEntry(r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, e)
}

func (h *Handler) verify(w http.ResponseWriter, _ *http.Request) {
	ok, badIndex, err := h.svc.store.VerifyChain()
	if err != nil {
		writeErr(w, err)
		return
	}
	if !ok {
		metrics.AuditChainVerifyFailuresTotal.Inc()
	}
	count, err := h.svc.store.Count()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"valid":     ok,
		"bad_index": badIndex,
		"entries":   count,
	})
}

func (h *Handler) createRight(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Protected   bool   `json:"protected"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.Name == "" {
		writeErr(w, ErrInvalid)
		return
	}
	right, err := h.svc.store.CreateRight(in.Name, in.Description, in.Protected)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, right)
}

func (h *Handler) listRights(w http.ResponseWriter, _ *http.Request) {
	rights, err := h.svc.store.ListRights()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rights": rights})
}

func (h *Handler) triggerReview(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ProposalID       string   `json:"proposal_id"`
		AffectedRightIDs []string `json:"affected_right_ids"`
		ReviewerRef      string   `json:"reviewer_ref"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	reviews, blocked, err := h.svc.TriggerReview(ReviewTrigger(in))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"reviews": reviews, "blocked": blocked})
}

func (h *Handler) listReviews(w http.ResponseWriter, r *http.Request) {
	reviews, err := h.svc.store.ListReviews(r.URL.Query().Get("proposal_id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reviews": reviews})
}

// registerChange opens the DP-043 gate for a protocol change.
func (h *Handler) registerChange(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ChangeRef         string    `json:"change_ref"`
		RequiredApprovals []string  `json:"required_approval_refs"`
		DelayUntil        time.Time `json:"delay_until"`
		VisibleSince      time.Time `json:"visible_since"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	c, err := h.svc.RegisterChange(RegisterChangeInput(in))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (h *Handler) listChanges(w http.ResponseWriter, _ *http.Request) {
	changes, err := h.svc.store.ListProtocolChanges()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"changes": changes})
}

func (h *Handler) getChange(w http.ResponseWriter, r *http.Request) {
	c, err := h.svc.store.GetProtocolChange(r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (h *Handler) recordApproval(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Ref         string `json:"ref"`
		ApproverRef string `json:"approver_ref"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	c, err := h.svc.RecordApproval(r.PathValue("id"), in.Ref, in.ApproverRef, time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, c)
}

func (h *Handler) releaseChange(w http.ResponseWriter, r *http.Request) {
	c, err := h.svc.ReleaseChange(r.PathValue("id"), time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}
