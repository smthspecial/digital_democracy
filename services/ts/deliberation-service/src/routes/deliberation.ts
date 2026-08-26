import type { FastifyInstance } from "fastify";
import type { DeliberationService } from "../services/deliberation.js";
import type { DeliberationArgument, Preference, Stance } from "../domain/types.js";

function serializeArgument(argument: DeliberationArgument) {
  return {
    id: argument.id,
    proposal_id: argument.proposal_id,
    citizen_id: argument.citizen_id,
    parent_id: argument.parent_id,
    content: argument.content,
    evidence_ref: argument.evidence_ref,
    stance: argument.stance,
    locked: argument.locked,
    created_at: argument.created_at.toISOString(),
  };
}

function serializePreference(preference: Preference) {
  return {
    id: preference.id,
    problem_id: preference.problem_id,
    citizen_id: preference.citizen_id,
    description: preference.description,
    created_at: preference.created_at.toISOString(),
  };
}

const argumentResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    proposal_id: { type: "string" },
    citizen_id: { type: "string" },
    parent_id: { type: ["string", "null"] },
    content: { type: "string" },
    evidence_ref: { type: "string" },
    stance: { type: "string", enum: ["agreement", "disagreement"] },
    locked: { type: "boolean" },
    created_at: { type: "string" },
  },
} as const;

const preferenceResponseSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    problem_id: { type: "string" },
    citizen_id: { type: "string" },
    description: { type: "string" },
    created_at: { type: "string" },
  },
} as const;

interface PostArgumentBody {
  proposal_id: string;
  citizen_id: string;
  parent_id?: string | null;
  content: string;
  evidence_ref: string;
  stance: Stance;
}

interface PostPreferenceBody {
  problem_id: string;
  citizen_id: string;
  description: string;
}

export function registerDeliberationRoutes(app: FastifyInstance, service: DeliberationService): void {
  app.post<{ Body: PostArgumentBody }>(
    "/deliberation/arguments",
    {
      schema: {
        body: {
          type: "object",
          required: ["proposal_id", "citizen_id", "content", "evidence_ref", "stance"],
          additionalProperties: false,
          properties: {
            proposal_id: { type: "string", minLength: 1 },
            citizen_id: { type: "string", minLength: 1 },
            parent_id: { type: ["string", "null"] },
            content: { type: "string", minLength: 1 },
            evidence_ref: { type: "string", minLength: 1 },
            stance: { type: "string", enum: ["agreement", "disagreement"] },
          },
        },
        response: { 201: argumentResponseSchema },
      },
    },
    async (request, reply) => {
      const argument = service.postArgument(request.body);
      reply.status(201);
      return serializeArgument(argument);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/deliberation/arguments/:id/lock",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: { 200: argumentResponseSchema },
      },
    },
    async (request) => {
      const argument = service.lockArgument(request.params.id);
      return serializeArgument(argument);
    },
  );

  // Flat list, parent_id included -- clients reconstruct the reply tree
  // client-side rather than the server shipping a nested structure.
  app.get<{ Params: { proposalId: string } }>(
    "/deliberation/proposals/:proposalId/arguments",
    {
      schema: {
        params: {
          type: "object",
          required: ["proposalId"],
          properties: { proposalId: { type: "string" } },
        },
        response: { 200: { type: "array", items: argumentResponseSchema } },
      },
    },
    async (request) => {
      return service.listArgumentsByProposal(request.params.proposalId).map(serializeArgument);
    },
  );

  app.post<{ Body: PostPreferenceBody }>(
    "/deliberation/preferences",
    {
      schema: {
        body: {
          type: "object",
          required: ["problem_id", "citizen_id", "description"],
          additionalProperties: false,
          properties: {
            problem_id: { type: "string", minLength: 1 },
            citizen_id: { type: "string", minLength: 1 },
            description: { type: "string", minLength: 1 },
          },
        },
        response: { 201: preferenceResponseSchema },
      },
    },
    async (request, reply) => {
      const preference = service.declarePreference(request.body);
      reply.status(201);
      return serializePreference(preference);
    },
  );

  app.get<{ Params: { problemId: string } }>(
    "/deliberation/problems/:problemId/preferences",
    {
      schema: {
        params: {
          type: "object",
          required: ["problemId"],
          properties: { problemId: { type: "string" } },
        },
        response: { 200: { type: "array", items: preferenceResponseSchema } },
      },
    },
    async (request) => {
      return service.listPreferencesByProblem(request.params.problemId).map(serializePreference);
    },
  );
}
