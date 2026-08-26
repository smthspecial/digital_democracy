import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerDeliberationRoutes } from "./routes/deliberation.js";
import { createStore, type Store } from "./store.js";
import { createDeliberationService } from "./services/deliberation.js";
import { DomainError } from "./errors.js";
import {
  noopAuditEmitter,
  noopSynthesisTrigger,
  DEFAULT_SYNTHESIS_THRESHOLD,
  type AuditEmitter,
  type SynthesisTrigger,
} from "./collaborators.js";

export interface Deps {
  store: Store;
  auditEmitter: AuditEmitter;
  synthesisTrigger: SynthesisTrigger;
  synthesisThreshold: number;
}

export function buildServer(deps: Partial<Deps> = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  registerHealthRoutes(app);

  const store = deps.store ?? createStore();
  const service = createDeliberationService(store, {
    auditEmitter: deps.auditEmitter ?? noopAuditEmitter,
    synthesisTrigger: deps.synthesisTrigger ?? noopSynthesisTrigger,
    synthesisThreshold: deps.synthesisThreshold ?? DEFAULT_SYNTHESIS_THRESHOLD,
  });
  registerDeliberationRoutes(app, service);

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof DomainError) {
      reply.status(err.statusCode).send({ error: err.message });
      return;
    }
    if (err.validation) {
      reply.status(400).send({ error: err.message });
      return;
    }
    request.log.error(err);
    reply.status(500).send({ error: "internal server error" });
  });

  return app;
}
