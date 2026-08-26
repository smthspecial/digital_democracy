import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import { publishAssessment } from "../services/assessments.js";
import { serializeAssessment } from "../serializers.js";

const publishSchema = {
  body: {
    type: "object",
    required: ["proposal_id", "citizen_id", "domain_id", "content", "score"],
    additionalProperties: false,
    properties: {
      proposal_id: { type: "string", minLength: 1 },
      citizen_id: { type: "string", minLength: 1 },
      domain_id: { type: "string", minLength: 1 },
      content: { type: "string", minLength: 1 },
      score: { type: "number" },
    },
  },
} as const;

export function registerAssessmentRoutes(app: FastifyInstance, store: Store) {
  app.post<{
    Body: {
      proposal_id: string;
      citizen_id: string;
      domain_id: string;
      content: string;
      score: number;
    };
  }>("/competency/assessments", { schema: publishSchema }, async (request, reply) => {
    const assessment = publishAssessment(store, {
      proposalId: request.body.proposal_id,
      citizenId: request.body.citizen_id,
      domainId: request.body.domain_id,
      content: request.body.content,
      score: request.body.score,
    });
    reply.code(201);
    return serializeAssessment(assessment);
  });
}
