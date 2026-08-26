package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// newRouter wires the liveness/readiness contract every service
// implements identically (see infra/helm/service/templates/deployment.yaml's
// probes), plus this service's business routes (SRV-017).
func newRouter(logger *slog.Logger, svc *Service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /readyz", handleReadyz)

	a := &api{svc: svc}
	mux.HandleFunc("POST /auth/login", a.handleLogin)
	mux.HandleFunc("POST /auth/logout", a.handleLogout)
	mux.HandleFunc("POST /auth/refresh", a.handleRefresh)
	mux.HandleFunc("POST /auth/factors", a.handleEnrollFactor)
	mux.HandleFunc("POST /auth/stepup", a.handleStepUp)
	mux.HandleFunc("POST /auth/internal/validate", a.handleValidate)
	mux.HandleFunc("POST /auth/internal/revoke-all/{citizenID}", a.handleRevokeAll)
	mux.HandleFunc("POST /auth/internal/purge-sessions", a.handlePurgeSessions)

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
