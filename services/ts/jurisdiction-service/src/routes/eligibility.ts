import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps.js";
import { checkEligibility, DEFAULT_MIN_RESIDENCY_DAYS } from "../services/eligibility.js";

interface EligibilityQuery {
  citizen_id: string;
  scope_jurisdiction_id: string;
  min_residency_days?: number;
}

export function registerEligibilityRoutes(app: FastifyInstance, deps: Deps) {
  app.get<{ Querystring: EligibilityQuery }>(
    "/jurisdiction/eligibility",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["citizen_id", "scope_jurisdiction_id"],
          properties: {
            citizen_id: { type: "string" },
            scope_jurisdiction_id: { type: "string" },
            min_residency_days: { type: "integer", minimum: 0 },
          },
        },
      },
    },
    async (request) =>
      checkEligibility(
        deps.store,
        request.query.citizen_id,
        request.query.scope_jurisdiction_id,
        request.query.min_residency_days ?? DEFAULT_MIN_RESIDENCY_DAYS,
      ),
  );
}
