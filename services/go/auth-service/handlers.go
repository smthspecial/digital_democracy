package main

import (
	"encoding/json"
	"net/http"
	"time"
)

// api holds the handler dependencies. citizen_status is deliberately not a
// loginRequest field: it is resolved server-side via identity, not trusted
// from the request body (see IdentityChecker in service.go). credential_valid
// has no identity-service equivalent (no credential store exists in this
// codebase yet) and remains caller-supplied, same as before.
type api struct {
	svc      *Service
	identity IdentityChecker
}

type loginRequest struct {
	CitizenID         string `json:"citizen_id"`
	CredentialValid   bool   `json:"credential_valid"`
	DeviceFingerprint string `json:"device_fingerprint"`
	IPSubnet          string `json:"ip_subnet"`
}

type loginResponse struct {
	*Session
	RequiresStepUp       bool     `json:"requires_step_up"`
	AvailableFactorTypes []string `json:"available_factor_types"`
}

func (a *api) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	// Any lookup failure (unreachable identity-service, unknown citizen) is
	// treated as an unrecognized status, not surfaced separately: Login's
	// existing generic-denial branch already handles it with no detail leak.
	status, _ := a.identity.CitizenStatus(req.CitizenID)
	sess, requiresStepUp, factorTypes, err := a.svc.Login(req.CitizenID, status, req.CredentialValid, req.DeviceFingerprint, req.IPSubnet, time.Now())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, loginResponse{Session: sess, RequiresStepUp: requiresStepUp, AvailableFactorTypes: factorTypes})
}

type logoutRequest struct {
	SessionID string `json:"session_id"`
}

func (a *api) handleLogout(w http.ResponseWriter, r *http.Request) {
	var req logoutRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if err := a.svc.Logout(req.SessionID, time.Now()); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// refreshRequest.RefreshToken would be an httpOnly cookie in a real
// client-facing deployment; it's accepted as a body field here since this
// phase has no cookie-issuing layer in front of the API.
type refreshRequest struct {
	RefreshToken      string `json:"refresh_token"`
	DeviceFingerprint string `json:"device_fingerprint"`
	IPSubnet          string `json:"ip_subnet"`
}

func (a *api) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var req refreshRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	sess, newRefreshToken, err := a.svc.RefreshToken(req.RefreshToken, req.DeviceFingerprint, req.IPSubnet, time.Now())
	if err != nil {
		writeError(w, err)
		return
	}
	sess.RefreshToken = newRefreshToken
	writeJSON(w, http.StatusOK, sess)
}

type enrollFactorRequest struct {
	CitizenID  string `json:"citizen_id"`
	SessionID  string `json:"session_id"`
	FactorType string `json:"factor_type"`

	TOTPSecret string `json:"totp_secret,omitempty"`
	TOTPCode   string `json:"totp_code,omitempty"`

	PasskeyCredentialID string `json:"passkey_credential_id,omitempty"`
	PasskeyPublicKey    []byte `json:"passkey_public_key,omitempty"`
	PasskeyChallenge    []byte `json:"passkey_challenge,omitempty"`
	PasskeySignature    []byte `json:"passkey_signature,omitempty"`

	Embedding          []float64 `json:"embedding,omitempty"`
	ReferenceEmbedding []float64 `json:"reference_embedding,omitempty"`
	Liveness           bool      `json:"liveness,omitempty"`
}

func (a *api) handleEnrollFactor(w http.ResponseWriter, r *http.Request) {
	var req enrollFactorRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	data := EnrollmentData{
		TOTPSecret:          req.TOTPSecret,
		TOTPCode:            req.TOTPCode,
		PasskeyCredentialID: req.PasskeyCredentialID,
		PasskeyPublicKeyDER: req.PasskeyPublicKey,
		PasskeyChallenge:    req.PasskeyChallenge,
		PasskeySignature:    req.PasskeySignature,
		Embedding:           req.Embedding,
		ReferenceEmbedding:  req.ReferenceEmbedding,
		Liveness:            req.Liveness,
	}
	factor, err := a.svc.EnrollFactor(req.CitizenID, req.SessionID, req.FactorType, data, time.Now())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, factor)
}

type stepUpRequest struct {
	SessionID  string `json:"session_id"`
	Tier       string `json:"tier"`
	FactorType string `json:"factor_type"`

	TOTPCode string `json:"totp_code,omitempty"`

	PasskeyChallenge []byte `json:"passkey_challenge,omitempty"`
	PasskeySignature []byte `json:"passkey_signature,omitempty"`

	Embedding []float64 `json:"embedding,omitempty"`
	Liveness  bool      `json:"liveness,omitempty"`
}

func (a *api) handleStepUp(w http.ResponseWriter, r *http.Request) {
	var req stepUpRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	proof := StepUpProof{
		TOTPCode:         req.TOTPCode,
		PasskeyChallenge: req.PasskeyChallenge,
		PasskeySignature: req.PasskeySignature,
		Embedding:        req.Embedding,
		Liveness:         req.Liveness,
	}
	sess, err := a.svc.CompleteStepUp(req.SessionID, req.Tier, req.FactorType, proof, time.Now())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sess)
}

type validateTokenRequest struct {
	AccessToken string `json:"access_token"`
}

func (a *api) handleValidate(w http.ResponseWriter, r *http.Request) {
	var req validateTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	sess, err := a.svc.ValidateAccessToken(req.AccessToken, time.Now())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sess)
}

func (a *api) handleRevokeAll(w http.ResponseWriter, r *http.Request) {
	citizenID := r.PathValue("citizenID")
	count, err := a.svc.RevokeAllSessions(citizenID, time.Now())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"count": count})
}

func (a *api) handlePurgeSessions(w http.ResponseWriter, r *http.Request) {
	count, err := a.svc.PurgeExpiredSessions(time.Now())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"count": count})
}

// writeError translates a domain error to its HTTP status. Errors that aren't
// a recognized domain error (statusForErr's default case) are unexpected
// internal failures, so their detail is not exposed to the client.
func writeError(w http.ResponseWriter, err error) {
	status := statusForErr(err)
	msg := err.Error()
	if status == http.StatusInternalServerError {
		msg = "internal error"
	}
	writeJSON(w, status, map[string]string{"error": msg})
}
