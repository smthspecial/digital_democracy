package auth

import (
	"log/slog"
	"net/http"
)

// NewRouter wires the HTTP surface (GET /healthz + GET /readyz contract).
func NewRouter(svc *Service, logger *slog.Logger) *http.ServeMux {
	h := &Handler{svc: svc}
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})

	mux.HandleFunc("POST /auth/login", h.login)
	mux.HandleFunc("POST /auth/refresh", h.refresh)
	mux.HandleFunc("POST /auth/logout", h.logout)
	mux.HandleFunc("GET /auth/validate", h.validate)
	mux.HandleFunc("POST /auth/factors", h.enroll)
	mux.HandleFunc("POST /auth/stepup", h.stepUp)
	mux.HandleFunc("POST /auth/revoke-all", h.revokeAll)
	mux.HandleFunc("POST /auth/purge", h.purge)
	mux.HandleFunc("GET /auth/events", h.events)

	_ = logger
	return mux
}
