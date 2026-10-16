package voting

import (
	"github.com/digital-democracy/api-go/internal/security"
	"log/slog"
	"net/http"
	"os"
)

// NewRouter wires the HTTP surface. Every service exposes GET /healthz
// (liveness) and GET /readyz (readiness) per the repo README contract.
func NewRouter(svc *Service, logger *slog.Logger, controls ...*security.Access) *http.ServeMux {
	h := &Handler{svc: svc, eligibility: NewHTTPEligibilitySource(os.Getenv("JURISDICTION_SERVICE_URL"), os.Getenv("INTERNAL_SERVICE_SHARED_SECRET")), proofs: NewHTTPBallotVerifier(os.Getenv("BALLOT_VERIFIER_URL"), os.Getenv("INTERNAL_SERVICE_SHARED_SECRET"))}
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

	mux.Handle("POST /voting/sessions", access.Internal("api-ts", http.HandlerFunc(h.createSession)))
	mux.HandleFunc("GET /voting/sessions", h.listSessions)
	mux.HandleFunc("GET /voting/sessions/{id}", h.getSession)
	mux.HandleFunc("GET /voting/sessions/{id}/options", h.listOptions)
	mux.Handle("POST /voting/sessions/{id}/options", access.Internal("api-ts", http.HandlerFunc(h.addOption)))
	mux.Handle("POST /voting/sessions/{id}/open", access.Internal("api-ts", http.HandlerFunc(h.openSession)))
	mux.Handle("POST /voting/sessions/{id}/close", access.Internal("api-ts", http.HandlerFunc(h.closeSession)))
	mux.Handle("POST /voting/sessions/{id}/tokens", access.Internal("api-ts", http.HandlerFunc(h.issueTokens)))
	mux.Handle("POST /voting/sessions/{id}/tally", access.Internal("api-ts", http.HandlerFunc(h.tally)))
	mux.Handle("POST /voting/sessions/{id}/certify", access.Internal("api-ts", http.HandlerFunc(h.certify)))
	mux.Handle("POST /voting/ballots", access.Citizen("T3", http.HandlerFunc(h.castBallot)))
	mux.HandleFunc("GET /voting/ballots/verify", h.verifyBallot)

	_ = logger
	return mux
}
