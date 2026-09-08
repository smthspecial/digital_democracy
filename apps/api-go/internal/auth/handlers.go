package auth

import (
	"encoding/json"
	"net/http"
	"time"
)

// Error mapping is deliberately coarse (AUTH-010 §Enforcement contract:
// reject with a structured error, no leaking of which guard failed).
// Suspended/revoked citizens get the same 401 as bad credentials (DP-059).

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
	case ErrUnauthorized:
		code, status = "unauthorized", http.StatusUnauthorized
	case ErrForbidden:
		code, status = "forbidden", http.StatusForbidden
	case ErrStepUpRequired:
		code, status = "step_up_required", http.StatusForbidden
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

// setRefreshCookie carries the refresh token httpOnly-only (DP-059: never in
// the response body).
func setRefreshCookie(w http.ResponseWriter, refresh string, expires time.Time) {
	http.SetCookie(w, &http.Cookie{
		Name:     "refresh_token",
		Value:    refresh,
		Path:     "/auth",
		Expires:  expires,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

type Handler struct{ svc *Service }

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CitizenID         string `json:"citizen_id"`
		DeviceFingerprint string `json:"device_fingerprint"`
		IPSubnet          string `json:"ip_subnet"`
		StepUpFactorType  string `json:"step_up_factor_type,omitempty"`
		StepUpProof       string `json:"step_up_proof,omitempty"`
		LivenessConfirmed bool   `json:"liveness_confirmed,omitempty"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	sess, tokens, err := h.svc.Login(LoginInput{
		CitizenID:         in.CitizenID,
		DeviceFingerprint: in.DeviceFingerprint,
		IP:                r.RemoteAddr,
		IPSubnet:          in.IPSubnet,
		StepUpFactorType:  in.StepUpFactorType,
		StepUpProof:       in.StepUpProof,
		LivenessConfirmed: in.LivenessConfirmed,
	}, time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	setRefreshCookie(w, tokens.RefreshToken, sess.ExpiresAt)
	factors, err := h.svc.store.ActiveFactors(in.CitizenID)
	if err != nil {
		writeErr(w, err)
		return
	}
	stepUp := tokens.AssuranceTier == TierT1 && len(factors) > 0
	writeJSON(w, http.StatusCreated, map[string]any{
		"session_id":        tokens.SessionID,
		"access_token":      tokens.AccessToken,
		"assurance_tier":    tokens.AssuranceTier,
		"access_expires_at": tokens.AccessExpiresAt,
		"step_up_required":  stepUp,
	})
}

func (h *Handler) refresh(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("refresh_token")
	if err != nil || cookie.Value == "" {
		writeErr(w, ErrUnauthorized)
		return
	}
	// Device/IP binding re-derives from headers the gateway sets; the stored
	// subnet is compared, never trusted from the body.
	tokens, err := h.svc.Refresh(cookie.Value,
		r.Header.Get("X-Device-Fingerprint"), r.Header.Get("X-IP-Subnet"), r.RemoteAddr, time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	setRefreshCookie(w, tokens.RefreshToken, time.Now().UTC().Add(RefreshTTL))
	writeJSON(w, http.StatusOK, map[string]any{
		"session_id":        tokens.SessionID,
		"access_token":      tokens.AccessToken,
		"assurance_tier":    tokens.AssuranceTier,
		"access_expires_at": tokens.AccessExpiresAt,
	})
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Logout(bearer(r)); err != nil {
		writeErr(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "refresh_token", Path: "/auth", MaxAge: -1, HttpOnly: true})
	writeJSON(w, http.StatusOK, map[string]string{"status": "revoked"})
}

func (h *Handler) validate(w http.ResponseWriter, r *http.Request) {
	sess, err := h.svc.Validate(bearer(r), time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"citizen_id":     sess.CitizenID,
		"assurance_tier": sess.AssuranceTier,
		"session_id":     sess.ID,
	})
}

func (h *Handler) enroll(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CitizenID           string  `json:"citizen_id"`
		SessionID           string  `json:"session_id"`
		FactorType          string  `json:"factor_type"`
		TOTPSecret          string  `json:"totp_secret,omitempty"`
		PasskeyCredentialID string  `json:"passkey_credential_id,omitempty"`
		PasskeyPublicKey    string  `json:"passkey_public_key,omitempty"`
		BiometricEmbedding  string  `json:"biometric_embedding,omitempty"`
		LivenessConfirmed   bool    `json:"liveness_confirmed,omitempty"`
		ReferenceMatchScore float64 `json:"reference_match_score,omitempty"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	f, err := h.svc.Enroll(EnrollInput(in), time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":          f.ID,
		"citizen_id":  f.CitizenID,
		"factor_type": f.FactorType,
		"status":      f.Status,
	})
}

func (h *Handler) stepUp(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SessionID         string `json:"session_id"`
		FactorType        string `json:"factor_type"`
		Proof             string `json:"proof"`
		LivenessConfirmed bool   `json:"liveness_confirmed,omitempty"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	tokens, err := h.svc.StepUp(StepUpInput{
		SessionID:         in.SessionID,
		FactorType:        in.FactorType,
		Proof:             in.Proof,
		LivenessConfirmed: in.LivenessConfirmed,
		DeviceFingerprint: r.Header.Get("X-Device-Fingerprint"),
		IP:                r.RemoteAddr,
	}, time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"session_id":        tokens.SessionID,
		"access_token":      tokens.AccessToken,
		"assurance_tier":    tokens.AssuranceTier,
		"access_expires_at": tokens.AccessExpiresAt,
	})
}

func (h *Handler) revokeAll(w http.ResponseWriter, r *http.Request) {
	// Internal endpoint for identity-service only (mesh mTLS, AUTH-012).
	var in struct {
		CitizenID string `json:"citizen_id"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	n, err := h.svc.RevokeAll(in.CitizenID, time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"revoked": n})
}

func (h *Handler) purge(w http.ResponseWriter, _ *http.Request) {
	purged, err := h.svc.Purge(time.Now().UTC())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"purged": purged})
}

func (h *Handler) events(w http.ResponseWriter, r *http.Request) {
	events, err := h.svc.store.ListEvents(r.URL.Query().Get("citizen_id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": events})
}

func bearer(r *http.Request) string {
	const prefix = "Bearer "
	auth := r.Header.Get("Authorization")
	if len(auth) > len(prefix) && auth[:len(prefix)] == prefix {
		return auth[len(prefix):]
	}
	return ""
}
