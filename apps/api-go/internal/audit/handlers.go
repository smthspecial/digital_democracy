package audit

import (
	"encoding/json"
	"errors"
	"github.com/digital-democracy/api-go/internal/security"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/digital-democracy/api-go/internal/metrics"
)

// Public reads remain available; mutations authenticate their producer.

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
	if security.ServiceID(r) != "api-go" && (in.ActorRef == "voting-service" || in.ActorRef == "audit-service" || in.ActorRef == "auth-service" || in.ActorRef == "delegation-service" || in.ActionType == ActionVoteCertified) {
		security.Error(w, 403, "forbidden")
		return
	}
	if in.ActorRef == "" {
		writeErr(w, ErrInvalid)
		return
	}
	e, err := h.svc.Append(in.ActionType, security.ServiceID(r)+":"+in.ActorRef, in.Payload, in.IdempotencyKey)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, e)
}

func (h *Handler) list(w http.ResponseWriter, r *http.Request) {
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 || n > 1000 {
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
		fetchLimit = 1000
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
	countBefore, err := h.svc.store.Count()
	if err != nil {
		writeErr(w, err)
		return
	}
	if countBefore > 10000 {
		security.Error(w, 503, "verification_requires_offline_job")
		return
	}
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
	if in.Name == "" || len(in.Name) > 256 || len(in.Description) > 4096 {
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
	if len(rights) > 1000 {
		security.Error(w, 503, "rights_require_offline_query")
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
	if len(in.AffectedRightIDs) > 100 || len(in.ReviewerRef) > 256 || len(in.ProposalID) > 256 {
		writeErr(w, ErrInvalid)
		return
	}
	in.ReviewerRef = security.ServiceID(r) + ":" + in.ReviewerRef
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
		ChangeRef string `json:"change_ref"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	now := time.Now().UTC()
	c, err := h.svc.RegisterChange(RegisterChangeInput{ChangeRef: in.ChangeRef, RequiredApprovals: []string{"citizen_supermajority", "audit_confirmation", "body_endorsement"}, VisibleSince: now, DelayUntil: now.Add(24 * time.Hour)})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, c)
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
	change, err := h.svc.store.GetProtocolChange(r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	if len(change.RequiredApprovals) != 3 || change.DelayUntil.Sub(change.VisibleSince) < 24*time.Hour || change.CreatedAt.Sub(change.VisibleSince) < 0 || change.CreatedAt.Sub(change.VisibleSince) > time.Second {
		writeErr(w, ErrInvalidState("untrusted legacy gate policy"))
		return
	}
	approvals, err := protocolApprovals(change.ChangeRef)
	if err != nil {
		security.Error(w, 503, "approval_verification_unavailable")
		return
	}
	// Discard caller-recorded approvals and replace with current authoritative decisions.
	change.Approvals = approvals
	if _, err = h.svc.store.UpdateProtocolChange(change); err != nil {
		writeErr(w, err)
		return
	}
	c, err := h.svc.ReleaseChange(r.PathValue("id"), time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}
