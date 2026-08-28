import Fastify from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { createStore } from "./store.js";
import {
  noopAuditEmitter,
  noopAssignmentRequester,
  noopLedgerRecorder,
  noopProposalAuthorLookup,
  noopReputationEmitter,
} from "./integrations.js";
import { DomainError } from "./errors.js";
import type { Deps } from "./deps.js";

export function buildServer(deps: Partial<Deps> = {}) {
  const resolved: Deps = {
    store: deps.store ?? createStore(),
    auditEmitter: deps.auditEmitter ?? noopAuditEmitter,
    assignmentRequester: deps.assignmentRequester ?? noopAssignmentRequester,
    ledgerRecorder: deps.ledgerRecorder ?? noopLedgerRecorder,
    proposalAuthorLookup: deps.proposalAuthorLookup ?? noopProposalAuthorLookup,
    reputationEmitter: deps.reputationEmitter ?? noopReputationEmitter,
  };

  const app = Fastify({ logger: true });

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

  registerHealthRoutes(app);
  registerProjectRoutes(app, resolved);

  return app;
}
