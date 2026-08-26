package main

import (
	"encoding/json"
	"errors"
	"net/http"
)

type handlers struct {
	svc *Service
}

func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	var domainErr *DomainError
	if errors.As(err, &domainErr) {
		switch domainErr.Kind {
		case KindValidation:
			status = http.StatusBadRequest
		case KindNotFound:
			status = http.StatusNotFound
		case KindConflict:
			status = http.StatusConflict
		}
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

func decodeJSON(r *http.Request, dst any) error {
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		return validationError("malformed JSON body")
	}
	return nil
}

type appendLogRequest struct {
	ActionType     string `json:"action_type"`
	ActorRef       string `json:"actor_ref"`
	Payload        any    `json:"payload"`
	IdempotencyKey string `json:"idempotency_key"`
}

func (h *handlers) appendLog(w http.ResponseWriter, r *http.Request) {
	var req appendLogRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	entry, err := h.svc.Append(ActionType(req.ActionType), req.ActorRef, req.Payload, req.IdempotencyKey)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, entry)
}

func (h *handlers) listLog(w http.ResponseWriter, r *http.Request) {
	filter := ActionType(r.URL.Query().Get("action_type"))
	if filter != "" && !filter.Valid() {
		writeError(w, validationError("invalid action_type filter"))
		return
	}
	entries := h.svc.ListLog(filter)
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

func (h *handlers) verifyLog(w http.ResponseWriter, r *http.Request) {
	valid, brokenAt, err := h.svc.VerifyChainIntegrity()
	if err != nil {
		writeError(w, err)
		return
	}
	var brokenAtJSON any
	if brokenAt != "" {
		brokenAtJSON = brokenAt
	}
	writeJSON(w, http.StatusOK, map[string]any{"valid": valid, "broken_at": brokenAtJSON})
}

type createRightRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Protected   bool   `json:"protected"`
}

func (h *handlers) createRight(w http.ResponseWriter, r *http.Request) {
	var req createRightRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	right, err := h.svc.CreateRight(req.Name, req.Description, req.Protected)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, right)
}

func (h *handlers) listRights(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"rights": h.svc.ListRights()})
}

type reviewProposalRequest struct {
	ChangeSummary string `json:"change_summary"`
}

func (h *handlers) reviewProposal(w http.ResponseWriter, r *http.Request) {
	proposalID := r.PathValue("id")

	var req reviewProposalRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	reviews, blocked, err := h.svc.ReviewProposal(proposalID, req.ChangeSummary)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"blocked": blocked, "reviews": reviews})
}

type gateProtocolExecutionRequest struct {
	RequiredApprovalTypes []string `json:"required_approval_types"`
	ObtainedApprovalTypes []string `json:"obtained_approval_types"`
	DelayElapsed          bool     `json:"delay_elapsed"`
	PubliclyVisible       bool     `json:"publicly_visible"`
}

func (h *handlers) gateProtocolExecution(w http.ResponseWriter, r *http.Request) {
	var req gateProtocolExecutionRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, err)
		return
	}

	released, reason, err := h.svc.GateProtocolExecution(req.RequiredApprovalTypes, req.ObtainedApprovalTypes, req.DelayElapsed, req.PubliclyVisible)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"released": released, "reason": reason})
}
