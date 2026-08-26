import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAiSynthesisRoutes } from "./routes/ai-synthesis.js";
import { createSynthesisStore, type SynthesisStore } from "./store.js";
import { noopAuditEmitter, type AuditEmitter } from "./integrations/audit-emitter.js";
import { DomainError } from "./errors.js";

export interface Deps {
  store: SynthesisStore;
  auditEmitter: AuditEmitter;
}

export function buildServer(deps: Partial<Deps> = {}): FastifyInstance {
  const store = deps.store ?? createSynthesisStore();
  const auditEmitter = deps.auditEmitter ?? noopAuditEmitter;

  const app = Fastify({ logger: true });

  registerHealthRoutes(app);
  registerAiSynthesisRoutes(app, { store, auditEmitter });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      reply.status(error.statusCode).send({ error: error.message });
      return;
    }
    if (error.validation) {
      reply.status(400).send({ error: error.message });
      return;
    }
    request.log.error(error);
    reply.status(500).send({ error: "Internal server error" });
  });

  return app;
}
