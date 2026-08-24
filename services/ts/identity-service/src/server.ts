import Fastify from "fastify";
import { registerHealthRoutes } from "./routes/health.js";

export function buildServer() {
  const app = Fastify({ logger: true });
  registerHealthRoutes(app);
  // Business routes (SRV-001, DP-001/DP-002/...) are added here as they
  // are implemented -- see .spec/technical/services/srv-001.md.
  return app;
}
