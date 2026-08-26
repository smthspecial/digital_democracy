import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import { hasActiveCompetency } from "../services/competency.js";

const paramsSchema = {
  params: {
    type: "object",
    required: ["citizenId", "domainId"],
    properties: {
      citizenId: { type: "string", minLength: 1 },
      domainId: { type: "string", minLength: 1 },
    },
  },
} as const;

export function registerCitizenRoutes(app: FastifyInstance, store: Store) {
  app.get<{ Params: { citizenId: string; domainId: string } }>(
    "/competency/citizens/:citizenId/domains/:domainId",
    { schema: paramsSchema },
    async (request) => {
      const active = hasActiveCompetency(store, request.params.citizenId, request.params.domainId);
      return { active };
    },
  );
}
