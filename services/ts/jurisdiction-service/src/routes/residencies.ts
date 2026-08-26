import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps.js";
import { validation } from "../errors.js";
import { createResidency, verifyResidency } from "../services/residencies.js";

interface CreateResidencyBody {
  citizen_id: string;
  jurisdiction_id: string;
  start_date: string;
  end_date?: string | null;
}

interface VerifyQuery {
  citizen_id: string;
  jurisdiction_id: string;
  at?: string;
}

function parseDate(value: string, field: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw validation(`${field} is not a valid date`);
  }
  return date;
}

export function registerResidencyRoutes(app: FastifyInstance, deps: Deps) {
  app.post<{ Body: CreateResidencyBody }>(
    "/jurisdiction/residencies",
    {
      schema: {
        body: {
          type: "object",
          required: ["citizen_id", "jurisdiction_id", "start_date"],
          properties: {
            citizen_id: { type: "string" },
            jurisdiction_id: { type: "string" },
            start_date: { type: "string" },
            end_date: { type: ["string", "null"] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const residency = createResidency(deps.store, {
        citizen_id: request.body.citizen_id,
        jurisdiction_id: request.body.jurisdiction_id,
        start_date: parseDate(request.body.start_date, "start_date"),
        end_date: request.body.end_date ? parseDate(request.body.end_date, "end_date") : null,
      });
      reply.status(201).send({
        ...residency,
        start_date: residency.start_date.toISOString(),
        end_date: residency.end_date ? residency.end_date.toISOString() : null,
      });
    },
  );

  app.get<{ Querystring: VerifyQuery }>(
    "/jurisdiction/residency/verify",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["citizen_id", "jurisdiction_id"],
          properties: {
            citizen_id: { type: "string" },
            jurisdiction_id: { type: "string" },
            at: { type: "string" },
          },
        },
      },
    },
    async (request) => {
      const instant = request.query.at ? parseDate(request.query.at, "at") : new Date();
      const verified = verifyResidency(
        deps.store,
        request.query.citizen_id,
        request.query.jurisdiction_id,
        instant,
      );
      return { verified };
    },
  );
}
