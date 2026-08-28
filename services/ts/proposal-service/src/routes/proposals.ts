import type { FastifyInstance } from "fastify";
import type { ProposalService } from "../services/proposals.js";
import type { DeadlockState, ProposalRecord } from "../domain/types.js";

function toDeadlockResponse(d: DeadlockState) {
  return {
    active: d.active,
    stage: d.stage,
    entered_at: d.enteredAt ? d.enteredAt.toISOString() : null,
    resolved_at: d.resolvedAt ? d.resolvedAt.toISOString() : null,
    history: d.history.map((h) => ({
      stage: h.stage,
      reviewer_id: h.reviewerId,
      notes: h.notes,
      at: h.at.toISOString(),
    })),
  };
}

function toProposalResponse(p: ProposalRecord) {
  return {
    id: p.id,
    problem_id: p.problemId,
    author_id: p.authorId,
    title: p.title,
    description: p.description,
    status: p.status,
    scope_jurisdiction_id: p.scopeJurisdictionId,
    support_count: p.supportCount,
    support_threshold: p.supportThreshold,
    scope_challenge_pending: p.scopeChallengePending,
    created_at: p.createdAt.toISOString(),
    budget: {
      cost: p.budget.cost,
      funding_source: p.budget.fundingSource,
      maintenance_cost: p.budget.maintenanceCost,
      expected_benefits: p.budget.expectedBenefits,
    },
    constraints: p.constraints.map((c) => ({
      id: c.id,
      proposal_id: c.proposalId,
      author_id: c.authorId,
      text: c.text,
      agreed: c.agreed,
      created_at: c.createdAt.toISOString(),
    })),
    scope_challenges: p.scopeChallenges.map((c) => ({
      id: c.id,
      proposal_id: c.proposalId,
      citizen_id: c.citizenId,
      reason: c.reason,
      resolved: c.resolved,
      created_at: c.createdAt.toISOString(),
      resolved_at: c.resolvedAt ? c.resolvedAt.toISOString() : null,
    })),
    deadlock: toDeadlockResponse(p.deadlock),
  };
}

const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 1 } },
} as const;

const challengeParamsSchema = {
  type: "object",
  required: ["id", "challengeId"],
  properties: {
    id: { type: "string", minLength: 1 },
    challengeId: { type: "string", minLength: 1 },
  },
} as const;

export function registerProposalRoutes(
  app: FastifyInstance,
  service: ProposalService,
) {
  app.post<{
    Body: {
      problem_id: string;
      title: string;
      description: string;
      author_id: string;
    };
  }>(
    "/proposals",
    {
      schema: {
        body: {
          type: "object",
          required: ["problem_id", "title", "description", "author_id"],
          additionalProperties: false,
          properties: {
            problem_id: { type: "string", minLength: 1 },
            title: { type: "string", minLength: 1 },
            description: { type: "string", minLength: 1 },
            author_id: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const proposal = service.createProposal({
        problemId: request.body.problem_id,
        title: request.body.title,
        description: request.body.description,
        authorId: request.body.author_id,
      });
      reply.status(201).send(toProposalResponse(proposal));
    },
  );

  app.get("/proposals", async () => service.list().map(toProposalResponse));

  app.get<{ Params: { id: string } }>(
    "/proposals/:id",
    { schema: { params: idParamsSchema } },
    async (request) => toProposalResponse(service.get(request.params.id)),
  );

  app.post<{
    Params: { id: string };
    Body: { author_id: string; text: string };
  }>(
    "/proposals/:id/constraints",
    {
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          required: ["author_id", "text"],
          additionalProperties: false,
          properties: {
            author_id: { type: "string", minLength: 1 },
            text: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const proposal = service.addConstraint(request.params.id, {
        authorId: request.body.author_id,
        text: request.body.text,
      });
      reply.status(201).send(toProposalResponse(proposal));
    },
  );

  app.put<{
    Params: { id: string };
    Body: {
      cost?: number;
      funding_source?: string;
      maintenance_cost?: number;
      expected_benefits?: string;
    };
  }>(
    "/proposals/:id/budget",
    {
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            cost: { type: "number", minimum: 0 },
            funding_source: { type: "string", minLength: 1 },
            maintenance_cost: { type: "number", minimum: 0 },
            expected_benefits: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request) => {
      const proposal = service.upsertBudget(request.params.id, {
        cost: request.body.cost,
        fundingSource: request.body.funding_source,
        maintenanceCost: request.body.maintenance_cost,
        expectedBenefits: request.body.expected_benefits,
      });
      return toProposalResponse(proposal);
    },
  );

  app.post<{
    Params: { id: string };
    Body: { scope_jurisdiction_id: string; population: number };
  }>(
    "/proposals/:id/scope-assignment",
    {
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          required: ["scope_jurisdiction_id", "population"],
          additionalProperties: false,
          properties: {
            scope_jurisdiction_id: { type: "string", minLength: 1 },
            population: { type: "number", minimum: 0 },
          },
        },
      },
    },
    async (request) => {
      const proposal = service.assignScope(request.params.id, {
        scopeJurisdictionId: request.body.scope_jurisdiction_id,
        population: request.body.population,
      });
      return toProposalResponse(proposal);
    },
  );

  app.post<{
    Params: { id: string };
    Body: { citizen_id: string; reason: string };
  }>(
    "/proposals/:id/scope-challenges",
    {
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          required: ["citizen_id", "reason"],
          additionalProperties: false,
          properties: {
            citizen_id: { type: "string", minLength: 1 },
            reason: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const proposal = service.fileScopeChallenge(request.params.id, {
        citizenId: request.body.citizen_id,
        reason: request.body.reason,
      });
      reply.status(201).send(toProposalResponse(proposal));
    },
  );

  app.post<{ Params: { id: string; challengeId: string } }>(
    "/proposals/:id/scope-challenges/:challengeId/resolve",
    { schema: { params: challengeParamsSchema } },
    async (request) => {
      const proposal = service.resolveScopeChallenge(
        request.params.id,
        request.params.challengeId,
      );
      return toProposalResponse(proposal);
    },
  );

  app.post<{ Params: { id: string }; Body: { citizen_id: string } }>(
    "/proposals/:id/support",
    {
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          required: ["citizen_id"],
          additionalProperties: false,
          properties: { citizen_id: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const proposal = service.addSupport(
        request.params.id,
        request.body.citizen_id,
      );
      reply.status(201).send(toProposalResponse(proposal));
    },
  );

  app.post<{ Params: { id: string } }>(
    "/proposals/:id/advance",
    { schema: { params: idParamsSchema } },
    async (request) => {
      const proposal = await service.advance(request.params.id);
      return toProposalResponse(proposal);
    },
  );

  app.post<{
    Params: { id: string };
    Body: { outcome: "approved" | "rejected" | "archived" };
  }>(
    "/proposals/:id/resolve",
    {
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          required: ["outcome"],
          additionalProperties: false,
          properties: {
            outcome: {
              type: "string",
              enum: ["approved", "rejected", "archived"],
            },
          },
        },
      },
    },
    async (request) => {
      const proposal = service.resolveProposal(
        request.params.id,
        request.body.outcome,
      );
      return toProposalResponse(proposal);
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    "/proposals/:id/deadlock/enter",
    {
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          required: ["reason"],
          additionalProperties: false,
          properties: { reason: { type: "string", minLength: 1 } },
        },
      },
    },
    async (request) => {
      const proposal = service.enterDeadlock(request.params.id, {
        reason: request.body.reason,
      });
      return toProposalResponse(proposal);
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      reviewer_id: string;
      notes: string;
      outcome?: "approved" | "rejected" | "archived";
    };
  }>(
    "/proposals/:id/deadlock/advance",
    {
      schema: {
        params: idParamsSchema,
        body: {
          type: "object",
          required: ["reviewer_id", "notes"],
          additionalProperties: false,
          properties: {
            reviewer_id: { type: "string", minLength: 1 },
            notes: { type: "string", minLength: 1 },
            outcome: {
              type: "string",
              enum: ["approved", "rejected", "archived"],
            },
          },
        },
      },
    },
    async (request) => {
      const proposal = service.advanceDeadlock(request.params.id, {
        reviewerId: request.body.reviewer_id,
        notes: request.body.notes,
        outcome: request.body.outcome,
      });
      return toProposalResponse(proposal);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/proposals/:id/deadlock",
    { schema: { params: idParamsSchema } },
    async (request) =>
      toDeadlockResponse(service.getDeadlock(request.params.id)),
  );
}
