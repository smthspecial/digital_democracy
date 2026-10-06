package auth

import (
	"log/slog"
	"net/http"
)

// NewRouter wires the HTTP surface (GET /healthz + GET /readyz contract).
func NewRouter(svc *Service, logger *slog.Logger, internalSharedSecret string) *http.ServeMux {
	h := &Handler{svc: svc, internalSharedSecret: []byte(internalSharedSecret)}
	h.passkeys, _ = newPasskeyVerifier()
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})

	// Legacy bodies cannot prove credential possession. Disable those public
	// entry points; passkey ceremonies are the only session bootstrap.
	removed := func(w http.ResponseWriter, _ *http.Request) { writeErr(w, ErrUnauthorized) }
	mux.HandleFunc("POST /auth/login", removed)
	mux.HandleFunc("POST /auth/passkeys/registration/begin", h.beginRegistration)
	mux.HandleFunc("POST /auth/passkeys/registration/finish", h.finishRegistration)
	mux.HandleFunc("POST /auth/passkeys/login/begin", h.beginPasskeyLogin)
	mux.HandleFunc("POST /auth/passkeys/login/finish", h.finishPasskeyLogin)
	mux.HandleFunc("POST /auth/identities/provision", h.internalOnly("api-ts", h.provisionIdentity))
	mux.HandleFunc("POST /auth/refresh", h.refresh)
	mux.HandleFunc("POST /auth/logout", h.logout)
	mux.HandleFunc("GET /auth/validate", h.validate)
	mux.HandleFunc("POST /auth/factors", removed)
	mux.HandleFunc("POST /auth/stepup", removed)
	mux.HandleFunc("POST /auth/revoke-all", h.internalOnly("api-ts", h.revokeAll))
	mux.HandleFunc("GET /auth/events", h.events)

	_ = logger
	return mux
}
