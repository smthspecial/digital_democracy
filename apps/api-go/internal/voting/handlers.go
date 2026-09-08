package voting

import (
	"encoding/json"
	"net/http"
	"time"
)

// Handlers translate HTTP/JSON into Service calls (DP-016, DP-017, DP-025,
// DP-026, DP-027, DP-046, DP-047). Auth is intentionally absent: every
// route's required AUTH-010 permission (ballot:cast → T3, ballot:verify →
// T1, system-only DP-025/026/027/046/047) is enforced by the caller holding
// a validated auth-service token; this service checks session state only.

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
	case ErrInvalidState:
		code, status = "invalid_state", http.StatusUnprocessableEntity
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

func (h *Handler) createSession(w http.ResponseWriter, r *http.Request) {
	var in struct {
		ProposalID       string    `json:"proposal_id"`
		JurisdictionID   string    `json:"jurisdiction_id"`
		Method           string    `json:"method"`
		ThresholdRule    string    `json:"threshold_rule"`
		MinParticipation float64   `json:"min_participation"`
		CoolingOffUntil  time.Time `json:"cooling_off_until"`
		OpensAt          time.Time `json:"opens_at"`
		ClosesAt         time.Time `json:"closes_at"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	vs, err := h.svc.CreateSession(CreateSessionInput(in))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, vs)
}

func (h *Handler) listSessions(w http.ResponseWriter, _ *http.Request) {
	sessions, err := h.svc.store.ListSessions()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": sessions})
}

func (h *Handler) getSession(w http.ResponseWriter, r *http.Request) {
	vs, err := h.svc.store.GetSession(r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vs)
}

func (h *Handler) addOption(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	if _, err := h.svc.store.GetSession(sessionID); err != nil {
		writeErr(w, err)
		return
	}
	var in struct {
		ProposalID  string `json:"proposal_id"`
		Label       string `json:"label"`
		Description string `json:"description"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.ProposalID == "" || in.Label == "" {
		writeErr(w, ErrInvalid)
		return
	}
	o, err := h.svc.store.AddOption(&VoteOption{SessionID: sessionID, ProposalID: in.ProposalID, Label: in.Label, Description: in.Description})
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, o)
}

func (h *Handler) openSession(w http.ResponseWriter, r *http.Request) {
	vs, err := h.svc.TryOpen(r.PathValue("id"), time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vs)
}

func (h *Handler) closeSession(w http.ResponseWriter, r *http.Request) {
	vs, err := h.svc.TryClose(r.PathValue("id"), time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vs)
}

func (h *Handler) issueTokens(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CitizenIDs []string `json:"citizen_ids"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if len(in.CitizenIDs) == 0 {
		writeErr(w, ErrInvalid)
		return
	}
	tokens, err := h.svc.IssueTokens(r.PathValue("id"), in.CitizenIDs)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"tokens": tokens})
}

func (h *Handler) castBallot(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SessionID       string `json:"vote_session_id"`
		TokenID         string `json:"token_id"`
		TokenBlind      string `json:"token_blind"`
		EncryptedChoice string `json:"encrypted_choice"`
		CitizenID       string `json:"citizen_id,omitempty"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	b, err := h.svc.CastBallot(in.SessionID, in.TokenID, in.TokenBlind, in.EncryptedChoice, in.CitizenID)
	if err != nil {
		writeErr(w, err)
		return
	}
	// Only the verification code returns to the voter — never the ballot id
	// mapping, never another citizen's data (FR-004).
	writeJSON(w, http.StatusCreated, map[string]any{
		"vote_session_id":   b.SessionID,
		"verification_code": b.VerificationCode,
		"cast_at":           b.CastAt,
	})
}

func (h *Handler) verifyBallot(w http.ResponseWriter, r *http.Request) {
	b, err := h.svc.VerifyBallot(r.URL.Query().Get("code"))
	if err != nil {
		writeErr(w, err)
		return
	}
	// DP-017: presence only. The choice is never disclosed, so the code
	// cannot serve as proof to a third party (coercion resistance).
	writeJSON(w, http.StatusOK, map[string]any{
		"present":         true,
		"vote_session_id": b.SessionID,
		"cast_at":         b.CastAt,
	})
}

func (h *Handler) tally(w http.ResponseWriter, r *http.Request) {
	res, err := h.svc.Tally(r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (h *Handler) certify(w http.ResponseWriter, r *http.Request) {
	vs, err := h.svc.Certify(r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vs)
}
