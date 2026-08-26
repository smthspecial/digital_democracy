import Fastify from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerRoleRoutes } from "./routes/roles.js";
import { registerApprovalRoutes } from "./routes/approvals.js";
import { registerRotationRoutes } from "./routes/rotation.js";
import { createStore } from "./store.js";
import {
  defaultAuditEmitter,
  defaultCOIChecker,
  defaultNotificationEmitter,
  defaultProtocolChangeExecutor,
  defaultProtocolGateChecker,
  defaultReplacementRequester,
} from "./collaborators.js";
import type { Deps } from "./deps.js";
import { DomainError } from "./errors.js";

export function buildServer(deps: Partial<Deps> = {}) {
  const app = Fastify({ logger: true });

  const resolvedDeps: Deps = {
    store: deps.store ?? createStore(),
    protocolGateChecker: deps.protocolGateChecker ?? defaultProtocolGateChecker,
    coiChecker: deps.coiChecker ?? defaultCOIChecker,
    protocolChangeExecutor: deps.protocolChangeExecutor ?? defaultProtocolChangeExecutor,
    notificationEmitter: deps.notificationEmitter ?? defaultNotificationEmitter,
    replacementRequester: deps.replacementRequester ?? defaultReplacementRequester,
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
  registerRoleRoutes(app, resolvedDeps);
  registerApprovalRoutes(app, resolvedDeps);
  registerRotationRoutes(app, resolvedDeps);

  return app;
}
