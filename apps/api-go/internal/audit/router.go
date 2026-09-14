package audit

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

	mux.HandleFunc("POST /audit/log", h.append)
	mux.HandleFunc("GET /audit/log", h.list)
	mux.HandleFunc("GET /audit/log/{id}", h.get)
	mux.HandleFunc("GET /audit/verify", h.verify)
	mux.HandleFunc("POST /audit/rights", h.createRight)
	mux.HandleFunc("GET /audit/rights", h.listRights)
	mux.HandleFunc("POST /audit/reviews", h.triggerReview)
	mux.HandleFunc("GET /audit/reviews", h.listReviews)
	mux.HandleFunc("POST /audit/protocol-changes", h.registerChange)
	mux.HandleFunc("GET /audit/protocol-changes", h.listChanges)
	mux.HandleFunc("GET /audit/protocol-changes/{id}", h.getChange)
	mux.HandleFunc("POST /audit/protocol-changes/{id}/approvals", h.recordApproval)
	mux.HandleFunc("POST /audit/protocol-changes/{id}/release", h.releaseChange)

	_ = logger
	return mux
}
