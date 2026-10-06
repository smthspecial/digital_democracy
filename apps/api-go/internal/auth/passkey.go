package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

const ceremonyTTL = 5 * time.Minute

type passkeyUser struct {
	id          string
	credentials []webauthn.Credential
}

func (u passkeyUser) WebAuthnID() []byte {
	h := sha256.Sum256([]byte("digital-democracy:citizen:" + u.id))
	return h[:]
}
func (u passkeyUser) WebAuthnName() string                       { return "Civic account" }
func (u passkeyUser) WebAuthnDisplayName() string                { return "Civic account" }
func (u passkeyUser) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

type passkeyCeremony struct {
	Session           webauthn.SessionData `json:"session"`
	DeviceFingerprint string               `json:"device_fingerprint,omitempty"`
	IPSubnet          string               `json:"ip_subnet,omitempty"`
}

func newPasskeyVerifier() (*webauthn.WebAuthn, error) {
	rp, origin := os.Getenv("WEBAUTHN_RP_ID"), os.Getenv("WEBAUTHN_RP_ORIGIN")
	if rp == "" || origin == "" {
		return nil, ErrForbidden
	}
	return webauthn.New(&webauthn.Config{RPID: rp, RPOrigins: []string{origin}, RPDisplayName: "Digital Democracy",
		AuthenticatorSelection: protocol.AuthenticatorSelection{UserVerification: protocol.VerificationRequired},
		Timeouts:               webauthn.TimeoutsConfig{Login: webauthn.TimeoutConfig{Enforce: true, Timeout: ceremonyTTL}, Registration: webauthn.TimeoutConfig{Enforce: true, Timeout: ceremonyTTL}},
	})
}

func (h *Handler) passkeyReady(w http.ResponseWriter) bool {
	if h.passkeys == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "passkey authentication is not configured"})
		return false
	}
	return true
}

func (h *Handler) saveCeremony(citizen, kind string, payload any) (string, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	token := newToken()
	err = h.svc.store.InsertCeremony(sha256Hex(token), Ceremony{CitizenID: citizen, Kind: kind, Payload: data, ExpiresAt: time.Now().UTC().Add(ceremonyTTL)})
	return token, err
}

// Only identity-service may issue a first-credential grant. Active status is
// rechecked independently; the callback's caller has verified the evidence.
func (h *Handler) provisionIdentity(w http.ResponseWriter, r *http.Request) {
	if !h.passkeyReady(w) {
		return
	}
	var in struct {
		CitizenID string `json:"citizen_id"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.CitizenID == "" {
		writeErr(w, ErrInvalid)
		return
	}
	status, err := h.svc.identity.StatusOf(in.CitizenID)
	if err != nil || status != "active" {
		writeErr(w, ErrUnauthorized)
		return
	}
	factors, err := h.svc.store.ActiveFactors(in.CitizenID)
	if err != nil {
		writeErr(w, err)
		return
	}
	for _, f := range factors {
		if f.FactorType == FactorPasskey {
			writeErr(w, ErrForbidden)
			return
		}
	}
	token, err := h.saveCeremony(in.CitizenID, "enrollment", map[string]string{})
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, map[string]any{"enrollment_grant": token, "expires_in": int(ceremonyTTL.Seconds())})
}

func (h *Handler) beginRegistration(w http.ResponseWriter, r *http.Request) {
	if !h.passkeyReady(w) {
		return
	}
	grant, err := h.svc.store.ConsumeCeremony(sha256Hex(bearer(r)), "enrollment", time.Now().UTC())
	if err != nil {
		writeErr(w, ErrUnauthorized)
		return
	}
	options, session, err := h.passkeys.BeginRegistration(passkeyUser{id: grant.CitizenID})
	if err != nil {
		writeErr(w, ErrInvalid)
		return
	}
	token, err := h.saveCeremony(grant.CitizenID, "registration", passkeyCeremony{Session: *session})
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"ceremony_token": token, "options": options})
}

func (h *Handler) finishRegistration(w http.ResponseWriter, r *http.Request) {
	if !h.passkeyReady(w) {
		return
	}
	c, err := h.svc.store.ConsumeCeremony(sha256Hex(bearer(r)), "registration", time.Now().UTC())
	if err != nil {
		writeErr(w, ErrUnauthorized)
		return
	}
	status, err := h.svc.identity.StatusOf(c.CitizenID)
	if err != nil || status != "active" {
		writeErr(w, ErrUnauthorized)
		return
	}
	var state passkeyCeremony
	if json.Unmarshal(c.Payload, &state) != nil {
		writeErr(w, ErrUnauthorized)
		return
	}
	credential, err := h.passkeys.FinishRegistration(passkeyUser{id: c.CitizenID}, state.Session, r)
	if err != nil {
		writeErr(w, ErrUnauthorized)
		return
	}
	// An account gets its first passkey through provisioning only. Additional
	// credentials/recovery will require a separate authenticated workflow.
	factors, err := h.svc.store.ActiveFactors(c.CitizenID)
	if err != nil {
		writeErr(w, err)
		return
	}
	for _, f := range factors {
		if f.FactorType == FactorPasskey {
			writeErr(w, ErrForbidden)
			return
		}
	}
	data, err := json.Marshal(credential)
	if err != nil {
		writeErr(w, err)
		return
	}
	_, err = h.svc.store.InsertPasskey(&MfaFactor{CitizenID: c.CitizenID, FactorType: FactorPasskey, Status: FactorActive, PasskeyCredentialID: base64.RawURLEncoding.EncodeToString(credential.ID), LastUsedAt: time.Now().UTC()}, data)
	if err != nil {
		writeErr(w, err)
		return
	}
	h.svc.recordEvent(c.CitizenID, "", EventFactorEnrolled, FactorPasskey, "", "", "")
	_ = h.svc.audit.Emit("identity_event", "auth-service", "passkey_enrolled:"+c.CitizenID)
	writeJSON(w, http.StatusCreated, map[string]string{"status": "enrolled"})
}

type storedPasskey struct {
	factorID string
	data     json.RawMessage
}

func (h *Handler) passkeyUser(citizen string) (passkeyUser, map[string]storedPasskey, error) {
	user := passkeyUser{id: citizen}
	ids := map[string]storedPasskey{}
	factors, err := h.svc.store.ActiveFactors(citizen)
	if err != nil {
		return user, ids, err
	}
	for _, f := range factors {
		if f.FactorType != FactorPasskey {
			continue
		}
		data, err := h.svc.store.WebAuthnCredential(f.ID)
		if err != nil {
			continue
		}
		var credential webauthn.Credential
		if json.Unmarshal(data, &credential) != nil {
			return user, ids, ErrUnauthorized
		}
		user.credentials = append(user.credentials, credential)
		ids[string(credential.ID)] = storedPasskey{factorID: f.ID, data: data}
	}
	return user, ids, nil
}

func (h *Handler) beginPasskeyLogin(w http.ResponseWriter, r *http.Request) {
	if !h.passkeyReady(w) {
		return
	}
	var in struct {
		CitizenID         string `json:"citizen_id"`
		DeviceFingerprint string `json:"device_fingerprint"`
		IPSubnet          string `json:"ip_subnet"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	if in.CitizenID == "" || in.DeviceFingerprint == "" {
		writeErr(w, ErrInvalid)
		return
	}
	user, _, err := h.passkeyUser(in.CitizenID)
	if err != nil {
		writeErr(w, ErrUnauthorized)
		return
	}
	options, session, err := h.passkeys.BeginLogin(user, webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		writeErr(w, ErrUnauthorized)
		return
	}
	token, err := h.saveCeremony(in.CitizenID, "login", passkeyCeremony{Session: *session, DeviceFingerprint: in.DeviceFingerprint, IPSubnet: in.IPSubnet})
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"ceremony_token": token, "options": options})
}

func (h *Handler) finishPasskeyLogin(w http.ResponseWriter, r *http.Request) {
	if !h.passkeyReady(w) {
		return
	}
	c, err := h.svc.store.ConsumeCeremony(sha256Hex(bearer(r)), "login", time.Now().UTC())
	if err != nil {
		writeErr(w, ErrUnauthorized)
		return
	}
	var state passkeyCeremony
	if json.Unmarshal(c.Payload, &state) != nil {
		writeErr(w, ErrUnauthorized)
		return
	}
	user, ids, err := h.passkeyUser(c.CitizenID)
	if err != nil {
		writeErr(w, ErrUnauthorized)
		return
	}
	credential, err := h.passkeys.FinishLogin(user, state.Session, r)
	if err != nil || credential.Authenticator.CloneWarning {
		writeErr(w, ErrUnauthorized)
		return
	}
	data, err := json.Marshal(credential)
	if err != nil {
		writeErr(w, err)
		return
	}
	stored := ids[string(credential.ID)]
	if err = h.svc.store.SaveWebAuthnCredential(stored.factorID, data, stored.data); err != nil {
		writeErr(w, err)
		return
	}
	now := time.Now().UTC()
	sess, tokens, err := h.svc.issueSession(sessionInput{CitizenID: c.CitizenID, DeviceFingerprint: state.DeviceFingerprint, IPSubnet: state.IPSubnet, IP: r.RemoteAddr}, now)
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err = h.svc.store.SetTier(sess.ID, TierT3, now); err != nil {
		writeErr(w, err)
		return
	}
	tokens.AssuranceTier = TierT3
	_ = h.svc.store.TouchFactor(stored.factorID, now)
	h.svc.recordEvent(c.CitizenID, sess.ID, EventMFASuccess, FactorPasskey, r.RemoteAddr, state.DeviceFingerprint, "")
	setRefreshCookie(w, tokens.RefreshToken, sess.ExpiresAt)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, map[string]any{"session_id": tokens.SessionID, "access_token": tokens.AccessToken, "assurance_tier": tokens.AssuranceTier, "access_expires_at": tokens.AccessExpiresAt})
}
