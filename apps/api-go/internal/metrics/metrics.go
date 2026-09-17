// Package metrics is api-go's Prometheus instrumentation (ADR-026/ARCH-025
// §2: the app-level /metrics half kube-prometheus-stack was deployed ahead
// of -- see ARCH-027 US-056). One process-wide registry, plain global
// collectors (this package has no state of its own to manage), imported
// directly by the packages that need to increment something -- no DI seam,
// same pragmatic shape as audit's package-level action-type constants.
package metrics

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	HTTPRequestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total",
		Help: "Total HTTP requests, by service, route, method, and status code.",
	}, []string{"service", "route", "method", "status"})

	HTTPRequestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "http_request_duration_seconds",
		Help:    "HTTP request latency in seconds, by service and route.",
		Buckets: prometheus.DefBuckets,
	}, []string{"service", "route"})

	// AuditLogAppendsTotal: every hash-chained entry written (FR-060,
	// DP-036) -- the append-only log's own throughput, and a zero rate here
	// while the rest of the system is active is itself a signal worth
	// alerting on.
	AuditLogAppendsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "audit_log_appends_total",
		Help: "Audit log entries appended, by action_type.",
	}, []string{"action_type"})

	// AuditChainVerifyFailuresTotal: DP-036/ADR-005's tamper-evidence
	// guarantee failing is a critical-process event by definition.
	AuditChainVerifyFailuresTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "audit_chain_verify_failures_total",
		Help: "GET /audit/verify calls that reported an invalid chain.",
	})

	VoteBallotsCastTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "vote_ballots_cast_total",
		Help: "Ballots successfully cast (DP-016).",
	})

	VoteSessionsClosedTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vote_sessions_closed_total",
		Help: "Vote sessions closed, by whether quorum was met (DP-027).",
	}, []string{"quorum_met"})

	// DelegationEventsTotal: event is one of created|revoked|expired
	// (DP-014/DP-015/DP-045).
	DelegationEventsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "delegation_events_total",
		Help: "Delegation lifecycle events, by event type.",
	}, []string{"event"})

	// AuthLoginAttemptsTotal: outcome is one of success|rejected.
	AuthLoginAttemptsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "auth_login_attempts_total",
		Help: "Login attempts, by outcome.",
	}, []string{"outcome"})

	AuthAnomaliesTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "auth_anomalies_total",
		Help: "Anomalous auth events detected and flagged.",
	})
)

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// Middleware wraps next with request-count/duration instrumentation. route
// is a caller-supplied label (the mux mount prefix, e.g. "/voting"), not
// the raw request path -- path params (ids) would otherwise blow up cardinality.
func Middleware(service, route string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		HTTPRequestDuration.WithLabelValues(service, route).Observe(time.Since(start).Seconds())
		HTTPRequestsTotal.WithLabelValues(service, route, r.Method, strconv.Itoa(rec.status)).Inc()
	})
}

// Handler exposes the process-wide registry for Prometheus to scrape.
func Handler() http.Handler {
	return promhttp.Handler()
}
