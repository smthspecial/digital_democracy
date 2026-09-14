package delegation

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

	mux.HandleFunc("POST /delegation/delegations", h.create)
	mux.HandleFunc("GET /delegation/delegations", h.list)
	mux.HandleFunc("GET /delegation/delegations/{id}", h.get)
	mux.HandleFunc("DELETE /delegation/delegations/{id}", h.revoke)
	mux.HandleFunc("GET /delegation/resolve", h.resolve)
	mux.HandleFunc("POST /delegation/expire", h.expire)

	_ = logger
	return mux
}
