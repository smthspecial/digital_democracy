import Fastify from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProposalRoutes } from "./routes/proposals.js";
import { createStore, type ProposalStore } from "./store.js";
import { createProposalService } from "./services/proposals.js";
import {
  defaultAuditEmitter,
  defaultConstitutionalReviewer,
  defaultVoteSessionRequester,
  type AuditEmitter,
  type ConstitutionalReviewer,
  type VoteSessionRequester,
} from "./integrations.js";
import { DomainError } from "./errors.js";

export interface Deps {
  store: ProposalStore;
  constitutionalReviewer: ConstitutionalReviewer;
  voteSessionRequester: VoteSessionRequester;
  auditEmitter: AuditEmitter;
}

export function buildServer(deps: Partial<Deps> = {}) {
  const app = Fastify({ logger: true });

  const resolvedDeps: Deps = {
    store: deps.store ?? createStore(),
    constitutionalReviewer:
      deps.constitutionalReviewer ?? defaultConstitutionalReviewer,
    voteSessionRequester:
      deps.voteSessionRequester ?? defaultVoteSessionRequester,
    auditEmitter: deps.auditEmitter ?? defaultAuditEmitter,
  };

  const proposalService = createProposalService(resolvedDeps);

  registerHealthRoutes(app);
  registerProposalRoutes(app, proposalService);

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
    reply.status(500).send({ error: "internal server error" });
  });

  return app;
}
