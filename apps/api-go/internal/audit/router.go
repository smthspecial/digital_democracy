package audit

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

	mux.Handle("POST /audit/log", access.InternalEither([]string{"api-ts", "api-go"}, http.HandlerFunc(h.append)))
	mux.HandleFunc("GET /audit/log", h.list)
	mux.HandleFunc("GET /audit/log/{id}", h.get)
	mux.HandleFunc("GET /audit/verify", h.verify)
	mux.HandleFunc("GET /audit/signing-key", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"algorithm": "Ed25519", "public_key": svc.store.PublicKey()})
	})
	mux.Handle("POST /audit/rights", access.Internal("api-ts", http.HandlerFunc(h.createRight)))
	mux.HandleFunc("GET /audit/rights", h.listRights)
	mux.Handle("POST /audit/reviews", access.Internal("api-ts", http.HandlerFunc(h.triggerReview)))
	mux.HandleFunc("GET /audit/reviews", h.listReviews)
	mux.Handle("POST /audit/protocol-changes", access.Internal("api-ts", http.HandlerFunc(h.registerChange)))
	mux.HandleFunc("GET /audit/protocol-changes", h.listChanges)
	mux.HandleFunc("GET /audit/protocol-changes/{id}", h.getChange)
	mux.Handle("POST /audit/protocol-changes/{id}/approvals", access.Internal("api-ts", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		security.Error(w, 403, "authoritative_approvals_required")
	})))
	mux.Handle("POST /audit/protocol-changes/{id}/release", access.Internal("api-ts", http.HandlerFunc(h.releaseChange)))

	_ = logger
	return mux
}
