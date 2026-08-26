import Fastify from "fastify";
import {
  noopAuditEmitter,
  noopThresholdChecker,
  type AuditEmitter,
  type ThresholdChecker,
} from "./collaborators.js";
import { DomainError } from "./errors.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProblemRoutes } from "./routes/problems.js";
import { createStore, type Store } from "./store.js";

export interface Deps {
  store: Store;
  audit: AuditEmitter;
  thresholdChecker: ThresholdChecker;
}

export function buildServer(deps?: Partial<Deps>) {
  const app = Fastify({ logger: true });
  const resolvedDeps: Deps = {
    store: deps?.store ?? createStore(),
    audit: deps?.audit ?? noopAuditEmitter,
    thresholdChecker: deps?.thresholdChecker ?? noopThresholdChecker,
  };

  registerHealthRoutes(app);
  registerProblemRoutes(app, resolvedDeps);

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
    reply.code(500).send({ error: "Internal server error" });
  });

  return app;
}
