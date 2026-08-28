// Command voting-service is SRV-008 (.spec/technical/services/srv-008.md):
// ballot cryptography, eligibility tokens, and vote tallying (DP-016,
// DP-025, DP-026, DP-027, DP-041, DP-046, DP-047).
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	port := os.Getenv("PORT")
	if port == "" {
		port = "5001"
	}

	var delegation DelegationResolver
	if url := os.Getenv("DELEGATION_SERVICE_URL"); url != "" {
		delegation = newHTTPDelegationResolver(url)
	}
	var audit AuditEmitter
	if url := os.Getenv("AUDIT_SERVICE_URL"); url != "" {
		audit = newHTTPAuditEmitter(url)
	}

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      newRouterWithDeps(logger, delegation, audit),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("starting voting-service", "port", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	logger.Info("shutting down voting-service")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
}
