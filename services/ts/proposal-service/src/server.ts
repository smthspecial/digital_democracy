import Fastify from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProposalRoutes } from "./routes/proposals.js";
import { createStore, type ProposalStore } from "./store.js";
import { createProposalService } from "./services/proposals.js";
import {
  defaultAssignmentChecker,
  defaultAuditEmitter,
  defaultConstitutionalReviewer,
  defaultScopeEscalationRequester,
  defaultVoteSessionRequester,
  type AssignmentChecker,
  type AuditEmitter,
  type ConstitutionalReviewer,
  type ScopeEscalationRequester,
  type VoteSessionRequester,
} from "./integrations.js";
import { DomainError } from "./errors.js";

export interface Deps {
  store: ProposalStore;
  constitutionalReviewer: ConstitutionalReviewer;
  voteSessionRequester: VoteSessionRequester;
  auditEmitter: AuditEmitter;
  assignmentChecker: AssignmentChecker;
  scopeEscalationRequester: ScopeEscalationRequester;
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
    assignmentChecker: deps.assignmentChecker ?? defaultAssignmentChecker,
    scopeEscalationRequester:
      deps.scopeEscalationRequester ?? defaultScopeEscalationRequester,
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
