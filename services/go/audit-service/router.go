package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// newRouter wires the liveness/readiness contract every service
// implements identically (see infra/helm/service/templates/deployment.yaml's
// probes), plus this service's own business routes, backed by a fresh
// in-memory Service/Store.
func newRouter(logger *slog.Logger) http.Handler {
	return newRouterWithService(logger, NewService(NewStore()))
}

// newRouterWithService lets tests wire a specific Service instance.
func newRouterWithService(logger *slog.Logger, svc *Service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /readyz", handleReadyz)

	h := &handlers{svc: svc}
	mux.HandleFunc("POST /audit/log", h.appendLog)
	mux.HandleFunc("GET /audit/log", h.listLog)
	mux.HandleFunc("GET /audit/log/verify", h.verifyLog)
	mux.HandleFunc("POST /audit/rights", h.createRight)
	mux.HandleFunc("GET /audit/rights", h.listRights)
	mux.HandleFunc("POST /audit/proposals/{id}/constitutional-review", h.reviewProposal)
	mux.HandleFunc("POST /audit/protocol-changes/gate", h.gateProtocolExecution)

	return withLogging(logger, mux)
}

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func handleReadyz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func withLogging(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		logger.Info("request", "method", r.Method, "path", r.URL.Path)
		next.ServeHTTP(w, r)
	})
}
