export const config = {
  port: Number(process.env.PORT ?? 4006),
  // Optional: real queue wiring for AuditEmitter via the audit.append queue (ADR-023).
  // Unset -> falls back to the no-op default so the service still runs standalone.
  natsUrl: process.env.NATS_URL || null,
};
