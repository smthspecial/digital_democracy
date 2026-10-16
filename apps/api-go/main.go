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
	"github.com/digital-democracy/api-go/internal/metrics"
	"github.com/digital-democracy/api-go/internal/pg"
	"github.com/digital-democracy/api-go/internal/scheduler"
	"github.com/digital-democracy/api-go/internal/security"
	"github.com/digital-democracy/api-go/internal/voting"
	"github.com/digital-democracy/eventbus"
	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	if os.Getenv("MIGRATE_ONLY") == "1" {
		if os.Getenv("APP_ENV") == "production" {
			if err := security.VerifiedDatabaseURL(os.Getenv("MIGRATE_DATABASE_URL")); err != nil {
				logger.Error("unsafe migration TLS configuration")
				os.Exit(1)
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		pool, err := pg.Connect(ctx, os.Getenv("MIGRATE_DATABASE_URL"))
		if err != nil {
			logger.Error("migration connection failed", "error", err)
			os.Exit(1)
		}
		defer pool.Close()
		if err = pg.Up(ctx, pool, db.Files); err != nil {
			logger.Error("migration failed", "error", err)
			os.Exit(1)
		}
		return
	}

	if err := security.ProductionConfig(os.Getenv); err != nil {
		logger.Error("unsafe production configuration", "error", err)
		os.Exit(1)
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "5000"
	}

	// One process-wide NATS connection shared by all emitters and the audit
	// consumer (best practice: connections are thread-safe and multiplex).
	var bus *eventbus.Bus
	if url := os.Getenv("NATS_URL"); url != "" {
		if os.Getenv("INTERNAL_SERVICE_SHARED_SECRET") == "" {
			logger.Error("NATS audit ingestion requires producer signing credentials")
			os.Exit(1)
		}
		var err error
		tlsOptions, tlsErr := eventbus.TLSOptions(os.Getenv("NATS_TLS_CA_FILE"), os.Getenv("NATS_TLS_CERT_FILE"), os.Getenv("NATS_TLS_KEY_FILE"))
		if tlsErr != nil {
			logger.Error("broker TLS configuration failed", "error", tlsErr)
			os.Exit(1)
		}
		bus, err = eventbus.Connect(url, tlsOptions...)
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
	// (ADR-029 — migrations use the separate MIGRATE_ONLY job); otherwise the
	// in-memory stores. One shared pool for all four services (ADR-028).
	var (
		votingStore     voting.Store
		delegationStore delegation.Store
		auditStore      audit.Store
		authStore       auth.Store
		runtimePool     *pgxpool.Pool
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
		var privileged bool
		if err := pool.QueryRow(bootCtx, "SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb FROM pg_roles WHERE rolname=current_user").Scan(&privileged); err != nil || privileged {
			logger.Error("runtime database must use a restricted non-superuser role")
			os.Exit(1)
		}
		runtimePool = pool
		if len(os.Getenv("AUDIT_SIGNING_KEY")) < 32 {
			logger.Error("persistent audit requires AUDIT_SIGNING_KEY of at least 32 characters")
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

	// BUG-003: notification-service has no implementation anywhere yet
	// (ADR-031 carve-out) -- a configured NOTIFICATION_SERVICE_URL will
	// 404 on every dispatch, the same silent-failure shape BUG-001 was.
	// Warn loudly at startup rather than letting it fail quietly per-call.
	if url := os.Getenv("NOTIFICATION_SERVICE_URL"); url != "" {
		logger.Warn("NOTIFICATION_SERVICE_URL is set but no notification-service implementation exists yet (ADR-031); dispatches will fail", "url", url)
	}

	votingSvc := voting.NewService(votingStore,
		delegationResolverFromEnv(),
		votingAuditEmitter(bus, auditURL),
	)
	if os.Getenv("APP_ENV") == "production" {
		votingSvc.BlockUnreviewedProductionCrypto()
	}
	if url := os.Getenv("GOVERNANCE_SERVICE_URL"); url != "" {
		votingSvc.SetCertificationSink(voting.NewHTTPCertificationSink(url, os.Getenv("INTERNAL_SERVICE_SHARED_SECRET")))
	}
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

	schedulerCtx, cancelScheduler := context.WithCancel(context.Background())
	defer cancelScheduler()
	scheduler.Start(schedulerCtx, logger, scheduler.Job{
		Name:     "delegation.expire_due",
		Interval: delegationExpiryInterval(),
		Run: func(context.Context) error {
			expired, err := delegationSvc.ExpireDue(time.Now().UTC())
			if err != nil {
				return err
			}
			if len(expired) > 0 {
				logger.Info("delegation expiry sweep", "expired", len(expired))
			}
			return nil
		},
	}, scheduler.Job{
		Name:     "voting.reconcile_certified",
		Interval: time.Minute,
		Run:      func(context.Context) error { return votingSvc.ReconcileCertified() },
	}, scheduler.Job{
		Name:     "auth.purge_expired",
		Interval: authPurgeInterval(),
		Run: func(context.Context) error {
			purged, err := authSvc.Purge(time.Now().UTC())
			if err != nil {
				return err
			}
			if purged > 0 {
				logger.Info("auth expiry purge", "purged", purged)
			}
			return nil
		},
	})

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

	access := &security.Access{Secret: os.Getenv("INTERNAL_SERVICE_SHARED_SECRET"), Replays: &security.ReplayStore{Pool: runtimePool}, Validate: func(token string) (string, string, error) {
		sess, err := authSvc.Validate(token, time.Now().UTC())
		if err != nil {
			return "", "", err
		}
		return sess.CitizenID, sess.AssuranceTier, nil
	}}
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
	mux.Handle("/metrics", metrics.Handler())
	mux.Handle("/voting/", metrics.Middleware("voting", "/voting", voting.NewRouter(votingSvc, logger, access)))
	mux.Handle("/delegation/", metrics.Middleware("delegation", "/delegation", delegation.NewRouter(delegationSvc, logger, access)))
	mux.Handle("/audit/", metrics.Middleware("audit", "/audit", audit.NewRouter(auditSvc, logger, access)))
	mux.Handle("/auth/", metrics.Middleware("auth", "/auth", auth.NewRouter(authSvc, logger, os.Getenv("INTERNAL_SERVICE_SHARED_SECRET"), access.Replays)))

	srv := &http.Server{
		Addr:              os.Getenv("LISTEN_HOST") + ":" + port,
		Handler:           security.Limit(mux),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      10 * time.Second,
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
