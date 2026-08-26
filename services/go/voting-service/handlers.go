package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

type handlerEnv struct {
	svc *Service
}

func (h *handlerEnv) register(mux *http.ServeMux) {
	mux.HandleFunc("POST /voting/sessions", h.createSession)
	mux.HandleFunc("POST /voting/sessions/{id}/options", h.addOption)
	mux.HandleFunc("GET /voting/sessions/{id}", h.getSession)
	mux.HandleFunc("POST /voting/sessions/{id}/open", h.openSession)
	mux.HandleFunc("POST /voting/sessions/{id}/close", h.closeSession)
	mux.HandleFunc("POST /voting/ballots", h.castBallot)
	mux.HandleFunc("GET /voting/ballots/verify", h.verifyBallot)
}

func writeError(w http.ResponseWriter, err error) {
	writeJSON(w, statusForError(err), map[string]string{"error": err.Error()})
}

func decodeJSONBody(r *http.Request, dst any) error {
	if r.Body == nil {
		return nil
	}
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		return fmt.Errorf("%w: invalid JSON body", ErrValidation)
	}
	return nil
}

type createSessionRequest struct {
	ProposalID       string    `json:"proposal_id"`
	JurisdictionID   string    `json:"jurisdiction_id"`
	Method           string    `json:"method"`
	ThresholdRule    string    `json:"threshold_rule"`
	MinParticipation float64   `json:"min_participation"`
	CoolingOffUntil  time.Time `json:"cooling_off_until"`
	OpensAt          time.Time `json:"opens_at"`
	ClosesAt         time.Time `json:"closes_at"`
}

func (h *handlerEnv) createSession(w http.ResponseWriter, r *http.Request) {
	var req createSessionRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, err)
		return
	}
	session, err := h.svc.CreateSession(CreateSessionInput{
		ProposalID:       req.ProposalID,
		JurisdictionID:   req.JurisdictionID,
		Method:           VoteMethod(req.Method),
		ThresholdRule:    ThresholdRule(req.ThresholdRule),
		MinParticipation: req.MinParticipation,
		CoolingOffUntil:  req.CoolingOffUntil,
		OpensAt:          req.OpensAt,
		ClosesAt:         req.ClosesAt,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, session)
}

type addOptionRequest struct {
	ProposalID  string `json:"proposal_id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

func (h *handlerEnv) addOption(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	var req addOptionRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, err)
		return
	}
	opt, err := h.svc.AddOption(sessionID, AddOptionInput{
		ProposalID:  req.ProposalID,
		Label:       req.Label,
		Description: req.Description,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, opt)
}

func (h *handlerEnv) getSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	session, err := h.svc.GetSession(sessionID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, session)
}

type openSessionRequest struct {
	EligibleCitizenIDs []string `json:"eligible_citizen_ids"`
}

type openSessionResponse struct {
	Session      *VoteSession  `json:"session"`
	IssuedTokens []IssuedToken `json:"issued_tokens"`
}

func (h *handlerEnv) openSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	var req openSessionRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, err)
		return
	}
	if err := h.svc.TransitionOpen(sessionID, time.Now().UTC()); err != nil {
		writeError(w, err)
		return
	}
	issued, err := h.svc.IssueEligibilityTokens(sessionID, req.EligibleCitizenIDs)
	if err != nil {
		writeError(w, err)
		return
	}
	session, err := h.svc.GetSession(sessionID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, openSessionResponse{Session: session, IssuedTokens: issued})
}

type closeSessionResponse struct {
	Session *VoteSession `json:"session"`
	Tally   *TallyResult `json:"tally"`
}

func (h *handlerEnv) closeSession(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	session, err := h.svc.CloseSession(sessionID, time.Now().UTC())
	if err != nil {
		writeError(w, err)
		return
	}
	tally, err := h.svc.GetTally(sessionID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, closeSessionResponse{Session: session, Tally: tally})
}

type castBallotRequest struct {
	SessionID   string `json:"session_id"`
	TokenSecret string `json:"token_secret"`
	Choice      string `json:"choice"`
}

type ballotResponse struct {
	ID               string    `json:"id"`
	VerificationCode string    `json:"verification_code"`
	CastAt           time.Time `json:"cast_at"`
}

func (h *handlerEnv) castBallot(w http.ResponseWriter, r *http.Request) {
	var req castBallotRequest
	if err := decodeJSONBody(r, &req); err != nil {
		writeError(w, err)
		return
	}
	ballot, err := h.svc.CastBallot(req.SessionID, req.TokenSecret, req.Choice, time.Now().UTC())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, ballotResponse{
		ID:               ballot.ID,
		VerificationCode: ballot.VerificationCode,
		CastAt:           ballot.CastAt,
	})
}

func (h *handlerEnv) verifyBallot(w http.ResponseWriter, r *http.Request) {
	sessionID := r.URL.Query().Get("session_id")
	code := r.URL.Query().Get("code")
	found, err := h.svc.VerifyBallotInclusion(sessionID, code)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"found": found})
}
