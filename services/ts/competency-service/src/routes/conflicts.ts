import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import { declareConflict } from "../services/conflicts.js";
import { serializeConflict } from "../serializers.js";
import type { ExclusionEnforcer } from "../integrations.js";

const declareSchema = {
  body: {
    type: "object",
    required: ["citizen_id", "domain_id", "description"],
    additionalProperties: false,
    properties: {
      citizen_id: { type: "string", minLength: 1 },
      domain_id: { type: "string", minLength: 1 },
      description: { type: "string", minLength: 1 },
    },
  },
} as const;

export function registerConflictRoutes(
  app: FastifyInstance,
  store: Store,
  exclusionEnforcer: ExclusionEnforcer,
) {
  app.post<{ Body: { citizen_id: string; domain_id: string; description: string } }>(
    "/competency/conflicts",
    { schema: declareSchema },
    async (request, reply) => {
      const coi = declareConflict(store, exclusionEnforcer, {
        citizenId: request.body.citizen_id,
        domainId: request.body.domain_id,
        description: request.body.description,
      });
      reply.code(201);
      return serializeConflict(coi);
    },
  );
}
