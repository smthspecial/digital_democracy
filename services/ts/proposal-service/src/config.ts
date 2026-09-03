export const config = {
  port: Number(process.env.PORT ?? 4004),
  // Optional: real cross-service wiring for AuditEmitter/ConstitutionalReviewer.
  // Unset -> both fall back to their no-op defaults so the service still runs standalone.
  auditServiceUrl: process.env.AUDIT_SERVICE_URL || null,
  // Optional: real cross-service wiring for JurisdictionClient.
  // Unset -> falls back to the permissive default so the service still runs standalone.
  jurisdictionServiceUrl: process.env.JURISDICTION_SERVICE_URL || null,
  // Optional: real cross-service wiring for ProblemStatusNotifier.
  // Unset -> falls back to the no-op default so the service still runs standalone.
  problemServiceUrl: process.env.PROBLEM_SERVICE_URL || null,
  // Optional: real queue wiring for AuditEmitter via the audit.append queue
  // (ADR-023). Takes priority over auditServiceUrl's HTTP-based AuditEmitter
  // when both are set -- ConstitutionalReviewer still uses auditServiceUrl
  // regardless, since constitutional review is inherently synchronous.
  // Unset -> falls back to auditServiceUrl's HTTP AuditEmitter, or the no-op
  // default if that's unset too.
  natsUrl: process.env.NATS_URL || null,
};
