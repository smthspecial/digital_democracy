// Command auth-service is SRV-017 (.spec/technical/services/srv-017.md):
// Owns session lifecycle, MFA factor management, step-up authentication,
// and anomaly detection used by every other service.
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
		port = "5004"
	}

	enc, err := newEncryptor()
	if err != nil {
		logger.Error("failed to initialize encryption key", "error", err)
		os.Exit(1)
	}
	var audit AuditEmitter
	// NATS_URL (ADR-023) is the only AuditEmitter wiring this service has --
	// there is no HTTP fallback here, unlike voting-service's
	// AUDIT_SERVICE_URL. Unset -> falls back to the no-op default so the
	// service still runs standalone with zero configuration.
	if url := os.Getenv("NATS_URL"); url != "" {
		natsAudit, err := newNATSAuditEmitter(context.Background(), url)
		if err != nil {
			logger.Error("failed to connect NATS audit emitter", "error", err)
			os.Exit(1)
		}
		audit = natsAudit
	}
	svc := NewService(newStore(), enc, audit)

	var identity IdentityChecker
	if url := os.Getenv("IDENTITY_SERVICE_URL"); url != "" {
		identity = newHTTPIdentityChecker(url)
	}

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      newRouterWithDeps(logger, svc, identity),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("starting auth-service", "port", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	logger.Info("shutting down auth-service")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
}
