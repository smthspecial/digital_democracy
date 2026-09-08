// Command api-go is the single Go application hosting the four
// concurrency/crypto-critical services (ADR-027): voting (SRV-008),
// delegation (SRV-010), audit (SRV-012), and auth (SRV-017).
//
// One module, one binary, one port, one database (ADR-028). Each service
// keeps its own package boundary (internal/<service>), store, and route
// prefix, so the four can be split back into independent deployments without
// re-cutting domain code. Contracts live in openapi/.
//
// Cross-service seams default to hermetic stubs and become real calls via
// env (see wiring.go): NATS_URL enables the shared JetStream bus (ADR-023) —
// one process-wide connection for every emitter plus the audit.append durable
// consumer — while *_SERVICE_URL fallbacks keep the HTTP integration seams.
// DATABASE_URL switches persistence from the in-memory stores to Postgres
// via the sqlc-generated repositories (ADR-029); unset means in-memory.
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

	"github.com/digital-democracy/api-go/db"
	"github.com/digital-democracy/api-go/internal/audit"
	"github.com/digital-democracy/api-go/internal/auth"
	"github.com/digital-democracy/api-go/internal/delegation"
	"github.com/digital-democracy/api-go/internal/pg"
	"github.com/digital-democracy/api-go/internal/voting"
	"github.com/digital-democracy/eventbus"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	port := os.Getenv("PORT")
	if port == "" {
		port = "5000"
	}

	// One process-wide NATS connection shared by all emitters and the audit
	// consumer (best practice: connections are thread-safe and multiplex).
	var bus *eventbus.Bus
	if url := os.Getenv("NATS_URL"); url != "" {
		var err error
		bus, err = eventbus.Connect(url)
		if err != nil {
			logger.Error("failed to connect NATS", "error", err)
			os.Exit(1)
		}
		defer bus.Close()
		if err := bus.EnsureStream(eventbus.QueueAuditAppend); err != nil {
			logger.Error("failed to ensure audit.append stream", "error", err)
			os.Exit(1)
		}
	}

	auditURL := os.Getenv("AUDIT_SERVICE_URL")

	// Persistence: Postgres via sqlc repositories when DATABASE_URL is set
	// (ADR-029 — migrations run automatically at boot); otherwise the
	// in-memory stores. One shared pool for all four services (ADR-028).
	var (
		votingStore     voting.Store
		delegationStore delegation.Store
		auditStore      audit.Store
		authStore       auth.Store
	)
	if dbURL := os.Getenv("DATABASE_URL"); dbURL != "" {
		bootCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		pool, err := pg.Connect(bootCtx, dbURL)
		if err != nil {
			cancel()
			logger.Error("failed to connect Postgres", "error", err)
			os.Exit(1)
		}
		defer pool.Close()
		if err := pg.Up(bootCtx, pool, db.Files); err != nil {
			cancel()
			logger.Error("failed to migrate Postgres", "error", err)
			os.Exit(1)
		}
		cancel()
		votingStore = voting.NewPGStore(pool)
		delegationStore = delegation.NewPGStore(pool)
		auditStore = audit.NewPGStore(pool)
		authStore = auth.NewPGStore(pool)
		logger.Info("persistence: postgres (sqlc)")
	} else {
		votingStore = voting.NewStore()
		delegationStore = delegation.NewStore()
		auditStore = audit.NewStore()
		authStore = auth.NewStore()
		logger.Info("persistence: in-memory (DATABASE_URL unset)")
	}

	votingSvc := voting.NewService(votingStore,
		delegationResolverFromEnv(),
		votingAuditEmitter(bus, auditURL),
	)
	delegationSvc := delegation.NewService(delegationStore,
		competencyCheckerFromEnv(),
		delegationAuditEmitter(bus, auditURL),
	)
	auditSvc := audit.NewService(auditStore, auditNotifierFromEnv())
	authSvc := auth.NewService(authStore,
		identityCheckerFromEnv(),
		authAuditEmitter(bus, auditURL),
		authNotifierFromEnv(),
	)

	if bus != nil {
		consumerCtx, cancelConsumer := context.WithCancel(context.Background())
		defer cancelConsumer()
		sub, err := audit.StartAuditConsumer(consumerCtx, bus, auditSvc, logger)
		if err != nil {
			logger.Error("failed to start audit consumer", "error", err)
			os.Exit(1)
		}
		defer func() { _ = sub.Unsubscribe() }()
		logger.Info("audit consumer attached", "stream", eventbus.StreamName(eventbus.QueueAuditAppend))
	} else {
		logger.Info("NATS_URL unset, audit ingestion is HTTP-only")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ready"}`))
	})
	mux.Handle("/voting/", voting.NewRouter(votingSvc, logger))
	mux.Handle("/delegation/", delegation.NewRouter(delegationSvc, logger))
	mux.Handle("/audit/", audit.NewRouter(auditSvc, logger))
	mux.Handle("/auth/", auth.NewRouter(authSvc, logger))

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		logger.Info("starting api-go", "port", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server failed", "error", err)
			os.Exit(1)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	logger.Info("shutting down api-go")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
		os.Exit(1)
	}
}
