import Fastify from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerIdentityRoutes } from "./routes/identity.js";
import { createStore } from "./store.js";
import {
  createDefaultApprovalGate,
  createDefaultDuplicateSignal,
  createDefaultIdentityHasher,
  createNoopAuditEmitter,
  createNoopSessionRevoker,
} from "./collaborators.js";
import type { IdentityServiceDeps } from "./services/identity.js";
import { DomainError } from "./errors.js";

export function buildServer(deps?: Partial<IdentityServiceDeps>) {
  const app = Fastify({ logger: true });

  const resolvedDeps: IdentityServiceDeps = {
    store: deps?.store ?? createStore(),
    hasher: deps?.hasher ?? createDefaultIdentityHasher(),
    approvalGate: deps?.approvalGate ?? createDefaultApprovalGate(),
    audit: deps?.audit ?? createNoopAuditEmitter(),
    duplicateSignal: deps?.duplicateSignal ?? createDefaultDuplicateSignal(),
    sessionRevoker: deps?.sessionRevoker ?? createNoopSessionRevoker(),
  };

  registerHealthRoutes(app);
  registerIdentityRoutes(app, resolvedDeps);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      void reply.status(error.statusCode).send({ error: error.message });
      return;
    }
    if (error.validation) {
      void reply.status(400).send({ error: error.message });
      return;
    }
    request.log.error(error);
    void reply.status(500).send({ error: "Internal server error" });
  });

  return app;
}
