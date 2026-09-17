import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

// ADR-026/ARCH-025 §2: the app-level /metrics half kube-prometheus-stack
// was deployed ahead of (ARCH-027 US-056). One process-wide registry, plain
// module-level collectors -- imported directly by the services that need to
// increment something, same shape as apps/api-go's internal/metrics.
export const register = new Registry();
collectDefaultMetrics({ register });

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests, by route and status code.",
  labelNames: ["route", "method", "status"] as const,
  registers: [register],
});

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds, by route.",
  labelNames: ["route"] as const,
  registers: [register],
});

// identity.citizen_revoked executions (US-004/US-005, ADR-034) -- the
// multi-approval-gated critical action this app's own audit flagged as
// under-observed.
export const identityRevocationsExecutedTotal = new Counter({
  name: "identity_revocations_executed_total",
  help: "Identity revocations executed after the 2-of-2 approval gate cleared.",
  registers: [register],
});

// governance_role.approval_submitted (DP-023) -- the multi-approval
// mechanism EPIC-012 exists to guarantee.
export const governanceApprovalsSubmittedTotal = new Counter({
  name: "governance_approvals_submitted_total",
  help: "Governance-role approvals submitted, by approvalType.",
  labelNames: ["approvalType"] as const,
  registers: [register],
});

// audit-emitter delivery failures (best-effort, never blocks the caller --
// see common/audit-emitter.ts) -- a rising rate here means the audit trail
// is silently losing entries, exactly the failure mode BUG-001 was.
export const auditEmitFailuresTotal = new Counter({
  name: "audit_emit_failures_total",
  help: "AuditEmitter delivery failures (best-effort; the triggering action still succeeds).",
  registers: [register],
});

export const competencyExpirySweptTotal = new Counter({
  name: "competency_expiry_swept_total",
  help: "Competency records flipped from active to expired by the scheduled sweep.",
  registers: [register],
});
