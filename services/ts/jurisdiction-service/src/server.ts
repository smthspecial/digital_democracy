import Fastify from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerJurisdictionRoutes } from "./routes/jurisdictions.js";
import { registerResidencyRoutes } from "./routes/residencies.js";
import { registerMembershipRoutes } from "./routes/memberships.js";
import { registerEligibilityRoutes } from "./routes/eligibility.js";
import { createDefaultDeps, type Deps } from "./deps.js";
import { DomainError } from "./errors.js";

export function buildServer(deps: Partial<Deps> = {}) {
  const resolved = createDefaultDeps(deps);
  const app = Fastify({ logger: true });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      reply.status(error.statusCode).send({ error: error.message });
      return;
    }
    if (error.validation) {
      reply.status(400).send({ error: error.message });
      return;
    }
    app.log.error(error);
    reply.status(500).send({ error: "internal server error" });
  });

  registerHealthRoutes(app);
  registerJurisdictionRoutes(app, resolved);
  registerResidencyRoutes(app, resolved);
  registerMembershipRoutes(app, resolved);
  registerEligibilityRoutes(app, resolved);

  return app;
}
