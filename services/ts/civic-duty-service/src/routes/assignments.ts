import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import type { RandomSource } from "../services/weighting.js";
import type { CivicAssignmentType } from "../domain/types.js";
import {
  generateAssignment,
  transitionAssignment,
  rebalance,
  refreshAuditPool,
} from "../services/assignments.js";

const assignmentTypes = ["proposal_review", "audit_review", "expertise_verification", "budget_oversight"];

const generateBodySchema = {
  type: "object",
  required: ["type", "target_ref", "candidates"],
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: assignmentTypes },
    target_ref: { type: "string", minLength: 1 },
    candidates: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["citizen_id", "sphere_relevant", "competency_match"],
        additionalProperties: false,
        properties: {
          citizen_id: { type: "string", minLength: 1 },
          sphere_relevant: { type: "boolean" },
          competency_match: { type: "boolean" },
        },
      },
    },
  },
} as const;

const idParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
} as const;

const rebalanceBodySchema = {
  type: "object",
  required: ["candidates", "overload_threshold"],
  additionalProperties: false,
  properties: {
    candidates: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    overload_threshold: { type: "number", minimum: 0 },
  },
} as const;

const auditPoolRefreshBodySchema = {
  type: "object",
  required: ["candidates", "count"],
  additionalProperties: false,
  properties: {
    candidates: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
    count: { type: "integer", minimum: 0 },
  },
} as const;

export function registerAssignmentRoutes(app: FastifyInstance, store: Store, random: RandomSource) {
  app.post<{
    Body: {
      type: CivicAssignmentType;
      target_ref: string;
      candidates: { citizen_id: string; sphere_relevant: boolean; competency_match: boolean }[];
    };
  }>("/civic-duty/assignments/generate", { schema: { body: generateBodySchema } }, async (request, reply) => {
    const { type, target_ref: targetRef, candidates } = request.body;
    const result = generateAssignment(store, random, {
      type,
      targetRef,
      candidates: candidates.map((c) => ({
        citizenId: c.citizen_id,
        sphereRelevant: c.sphere_relevant,
        competencyMatch: c.competency_match,
      })),
    });
    reply.status(201);
    return result;
  });

  for (const action of ["accept", "abandon", "complete"] as const) {
    app.post<{ Params: { id: string } }>(
      `/civic-duty/assignments/:id/${action}`,
      { schema: { params: idParamsSchema } },
      async (request) => transitionAssignment(store, request.params.id, action),
    );
  }

  app.get<{ Params: { id: string } }>(
    "/civic-duty/citizens/:id/assignments",
    { schema: { params: idParamsSchema } },
    async (request) => store.listAssignmentsByCitizen(request.params.id),
  );

  app.post<{ Body: { candidates: string[]; overload_threshold: number } }>(
    "/civic-duty/assignments/rebalance",
    { schema: { body: rebalanceBodySchema } },
    async (request) => rebalance(store, request.body.candidates, request.body.overload_threshold),
  );

  app.post<{ Body: { candidates: string[]; count: number } }>(
    "/civic-duty/audit-pool/refresh",
    { schema: { body: auditPoolRefreshBodySchema } },
    async (request, reply) => {
      const created = refreshAuditPool(store, random, request.body.candidates, request.body.count);
      reply.status(201);
      return created;
    },
  );
}
