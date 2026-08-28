export const config = {
  port: Number(process.env.PORT ?? 4004),
  // Optional: real cross-service wiring for AuditEmitter/ConstitutionalReviewer.
  // Unset -> both fall back to their no-op defaults so the service still runs standalone.
  auditServiceUrl: process.env.AUDIT_SERVICE_URL || null,
};
