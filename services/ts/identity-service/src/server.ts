import Fastify from "fastify";
import type { ServiceDeps } from "./deps.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerCitizenRoutes } from "./routes/citizens.js";
import { registerVerificationRoutes } from "./routes/verifications.js";

export function buildServer(deps: ServiceDeps) {
  const app = Fastify({ logger: true });
  registerHealthRoutes(app);
  registerCitizenRoutes(app, deps);
  registerVerificationRoutes(app, deps);
  // Remaining SRV-001 data processes (DP-024 sweep counterpart DP-056,
  // DP-042 revocation cascade) are added as they are implemented -- see
  // .spec/technical/services/srv-001.md.
  return app;
}
