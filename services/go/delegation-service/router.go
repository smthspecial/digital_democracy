package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// newRouter wires the liveness/readiness contract every service
// implements identically (see infra/helm/service/templates/deployment.yaml's
// probes), plus this service's delegation business routes (SRV-010).
func newRouter(logger *slog.Logger, svc *Service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", handleHealthz)
	mux.HandleFunc("GET /readyz", handleReadyz)

	h := newHandler(svc)
	mux.HandleFunc("POST /delegation/delegations", h.createDelegation)
	mux.HandleFunc("GET /delegation/delegations", h.listDelegations)
	mux.HandleFunc("DELETE /delegation/delegations/{id}", h.revokeDelegation)
	mux.HandleFunc("POST /delegation/resolve", h.resolveChain)
	mux.HandleFunc("POST /delegation/internal/expire", h.expireDelegations)

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
