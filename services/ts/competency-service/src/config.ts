export const config = {
  port: Number(process.env.PORT ?? 4005),
  // Optional: real cross-service wiring for ReputationEmitter.
  // Unset -> falls back to the no-op default so the service still runs standalone.
  reputationServiceUrl: process.env.REPUTATION_SERVICE_URL || null,
};
