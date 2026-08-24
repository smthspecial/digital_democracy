import Fastify from "fastify";
import { registerHealthRoutes } from "./routes/health.js";

export function buildServer() {
  const app = Fastify({ logger: true });
  registerHealthRoutes(app);
  // Business routes (SRV-015) are added here as they
  // are implemented -- see .spec/technical/services/srv-015.md.
  return app;
}
