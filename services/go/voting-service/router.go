package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// newRouter wires the liveness/readiness contract every service
// implements identically (see infra/helm/service/templates/deployment.yaml's
// probes). Business routes are registered here as they're implemented.
// delegation/audit default to no-ops -- see newRouterWithDeps for the
// production wiring used when their target services are configured.
func newRouter(logger *slog.Logger) http.Handler {
	return newRouterWithDeps(logger, nil, nil)
}

// newRouterWithDeps lets main.go (and tests) supply real DelegationResolver
// / AuditEmitter implementations instead of the no-op defaults.
func newRouterWithDeps(logger *slog.Logger, delegation DelegationResolver, audit AuditEmitter) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /readyz", handleReadyz)

	env := &handlerEnv{svc: NewService(delegation, audit)}
	env.register(mux)

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
