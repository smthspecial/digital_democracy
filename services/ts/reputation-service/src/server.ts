import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerReputationRoutes } from "./routes/reputation.js";
import { DomainError } from "./errors.js";
import { createStore, type ReputationStore } from "./store.js";
import {
  noopAuditEmitter,
  noopNotificationEmitter,
  type AuditEmitter,
  type NotificationEmitter,
} from "./services/reputation.js";

export interface Deps {
  store: ReputationStore;
  notifications: NotificationEmitter;
  audit: AuditEmitter;
}

export function buildServer(deps: Partial<Deps> = {}): FastifyInstance {
  const app = Fastify({ logger: true });

  const resolvedDeps: Deps = {
    store: deps.store ?? createStore(),
    notifications: deps.notifications ?? noopNotificationEmitter,
    audit: deps.audit ?? noopAuditEmitter,
  };

  registerHealthRoutes(app);
  registerReputationRoutes(app, resolvedDeps);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    if (error.validation) {
      reply.code(400).send({ error: error.message });
      return;
    }
    request.log.error(error);
    reply.code(500).send({ error: "internal server error" });
  });

  return app;
}
