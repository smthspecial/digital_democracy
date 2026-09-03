import Fastify from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerPolicyRoutes } from "./routes/policies.js";
import { registerAttachmentRoutes } from "./routes/attachments.js";
import { registerEvaluateRoutes } from "./routes/evaluate.js";
import { createStore } from "./store.js";
import { defaultAuditEmitter, defaultGovernanceRoleChecker } from "./collaborators.js";
import type { Deps } from "./deps.js";
import { DomainError } from "./errors.js";

export function buildServer(deps: Partial<Deps> = {}) {
  const app = Fastify({ logger: true });

  const resolvedDeps: Deps = {
    store: deps.store ?? createStore(),
    governanceRoleChecker: deps.governanceRoleChecker ?? defaultGovernanceRoleChecker,
    auditEmitter: deps.auditEmitter ?? defaultAuditEmitter,
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.statusCode).send({ error: err.message });
    }
    if (err.validation) {
      return reply.status(400).send({ error: err.message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "internal server error" });
  });

  registerHealthRoutes(app);
  registerPolicyRoutes(app, resolvedDeps);
  registerAttachmentRoutes(app, resolvedDeps);
  registerEvaluateRoutes(app, resolvedDeps);

  return app;
}
