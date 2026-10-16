package delegation

import (
	"github.com/digital-democracy/api-go/internal/security"
	"log/slog"
	"net/http"
)

// NewRouter wires the HTTP surface (GET /healthz + GET /readyz contract).
func NewRouter(svc *Service, logger *slog.Logger, controls ...*security.Access) *http.ServeMux {
	h := &Handler{svc: svc}
	mux := http.NewServeMux()
	access := &security.Access{Replays: &security.ReplayStore{}}
	if len(controls) > 0 && controls[0] != nil {
		access = controls[0]
	}

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})

	mux.Handle("POST /delegation/delegations", access.Citizen("T2", http.HandlerFunc(h.create)))
	mux.HandleFunc("GET /delegation/delegations", h.list)
	mux.HandleFunc("GET /delegation/delegations/{id}", h.get)
	mux.Handle("DELETE /delegation/delegations/{id}", access.Citizen("T2", http.HandlerFunc(h.revoke)))
	mux.HandleFunc("GET /delegation/resolve", h.resolve)
	mux.Handle("POST /delegation/expire", access.Internal("api-ts", http.HandlerFunc(h.expire)))

	_ = logger
	return mux
}
