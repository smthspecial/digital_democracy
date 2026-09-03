export const config = {
  port: Number(process.env.PORT ?? 4009),
  // Optional: real cross-service wiring for COIChecker.
  // Unset -> falls back to the permissive default so the service still runs standalone.
  competencyServiceUrl: process.env.COMPETENCY_SERVICE_URL || null,
  // Optional: real queue wiring for AuditEmitter via the audit.append queue (ADR-023).
  // Unset -> falls back to the no-op default so the service still runs standalone.
  natsUrl: process.env.NATS_URL || null,
};
