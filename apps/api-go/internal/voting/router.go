package voting

import (
	"log/slog"
	"net/http"
)

// NewRouter wires the HTTP surface. Every service exposes GET /healthz
// (liveness) and GET /readyz (readiness) per the repo README contract.
func NewRouter(svc *Service, logger *slog.Logger) *http.ServeMux {
	h := &Handler{svc: svc}
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})

	mux.HandleFunc("POST /voting/sessions", h.createSession)
	mux.HandleFunc("GET /voting/sessions", h.listSessions)
	mux.HandleFunc("GET /voting/sessions/{id}", h.getSession)
	mux.HandleFunc("POST /voting/sessions/{id}/options", h.addOption)
	mux.HandleFunc("POST /voting/sessions/{id}/open", h.openSession)
	mux.HandleFunc("POST /voting/sessions/{id}/close", h.closeSession)
	mux.HandleFunc("POST /voting/sessions/{id}/tokens", h.issueTokens)
	mux.HandleFunc("POST /voting/sessions/{id}/tally", h.tally)
	mux.HandleFunc("POST /voting/sessions/{id}/certify", h.certify)
	mux.HandleFunc("POST /voting/ballots", h.castBallot)
	mux.HandleFunc("GET /voting/ballots/verify", h.verifyBallot)

	_ = logger
	return mux
}
