import type { FastifyInstance } from "fastify";

// Liveness/readiness contract every service implements identically --
// see infra/helm/service/templates/deployment.yaml's probes.
export function registerHealthRoutes(app: FastifyInstance) {
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));
}
