import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import { applyForCompetency, advanceCompetency, rejectCompetency } from "../services/competency.js";
import { serializeCompetency } from "../serializers.js";

const applySchema = {
  body: {
    type: "object",
    required: ["citizen_id", "domain_id"],
    additionalProperties: false,
    properties: {
      citizen_id: { type: "string", minLength: 1 },
      domain_id: { type: "string", minLength: 1 },
    },
  },
} as const;

const idParamsSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", minLength: 1 } },
  },
} as const;

export function registerApplicationRoutes(app: FastifyInstance, store: Store) {
  app.post<{ Body: { citizen_id: string; domain_id: string } }>(
    "/competency/applications",
    { schema: applySchema },
    async (request, reply) => {
      const competency = applyForCompetency(store, {
        citizenId: request.body.citizen_id,
        domainId: request.body.domain_id,
      });
      reply.code(201);
      return serializeCompetency(competency);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/competency/applications/:id/advance",
    { schema: idParamsSchema },
    async (request) => {
      const competency = advanceCompetency(store, request.params.id);
      return serializeCompetency(competency);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/competency/applications/:id/reject",
    { schema: idParamsSchema },
    async (request) => {
      const competency = rejectCompetency(store, request.params.id);
      return serializeCompetency(competency);
    },
  );
}
