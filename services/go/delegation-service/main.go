// Command delegation-service is SRV-010 (.spec/technical/services/srv-010.md):
// Owns liquid-democracy delegation creation, revocation, and chain
// resolution feeding the voting pipeline. Delegation CRUD, circular-graph
// rejection, chain resolution, and expiry enforcement (DP-014/015/041/045)
// are implemented against an in-memory store; see README.md.
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
		port = "5002"
	}

	var audit AuditEmitter
	// NATS_URL (ADR-023) is the only AuditEmitter wiring this service has.
	// Unset -> falls back to the no-op default so the service still runs
	// standalone with zero configuration.
	if url := os.Getenv("NATS_URL"); url != "" {
		natsAudit, err := newNATSAuditEmitter(context.Background(), url)
		if err != nil {
			logger.Error("failed to connect NATS audit emitter", "error", err)
			os.Exit(1)
		}
		audit = natsAudit
	}
	svc := NewService(NewStore(), nil, audit)

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      newRouter(logger, svc),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("starting delegation-service", "port", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	logger.Info("shutting down delegation-service")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
}
