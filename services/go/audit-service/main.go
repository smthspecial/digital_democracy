// Command audit-service is SRV-012 (.spec/technical/services/srv-012.md):
// Owns the append-only, hash-chained public audit log -- the highest
// write fan-in of any service. Only the
// health contract is wired up so far -- business handlers are added
// alongside their data processes as specified in .spec/technical/data-processes/.
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
		port = "5003"
	}

	svc := NewService(NewStore())

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      newRouterWithService(logger, svc),
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("starting audit-service", "port", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Optional: real cross-service wiring for the audit.append queue (ADR-023).
	// Unset -> the service still runs with only the synchronous POST /audit/log
	// endpoint, same as before this queue consumer existed.
	if natsURL := os.Getenv("NATS_URL"); natsURL != "" {
		if err := startAuditAppendConsumer(ctx, logger, natsURL, svc); err != nil {
			logger.Error("failed to start audit.append consumer", "error", err)
			os.Exit(1)
		}
		logger.Info("consuming audit.append", "nats_url", natsURL)
	}

	<-ctx.Done()

	logger.Info("shutting down audit-service")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
}
