export const config = {
  port: Number(process.env.PORT ?? 4001),
  // Optional: real cross-service wiring for SessionRevoker.
  // Unset -> falls back to the no-op default so the service still runs standalone.
  authServiceUrl: process.env.AUTH_SERVICE_URL || null,
};
