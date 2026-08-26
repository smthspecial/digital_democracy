import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps.js";
import { createMembership, listMemberships } from "../services/memberships.js";

interface CreateMembershipBody {
  citizen_id: string;
  jurisdiction_id: string;
}

interface ListMembershipsQuery {
  citizen_id: string;
}

export function registerMembershipRoutes(app: FastifyInstance, deps: Deps) {
  app.post<{ Body: CreateMembershipBody }>(
    "/jurisdiction/memberships",
    {
      schema: {
        body: {
          type: "object",
          required: ["citizen_id", "jurisdiction_id"],
          properties: {
            citizen_id: { type: "string" },
            jurisdiction_id: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const membership = createMembership(deps.store, request.body);
      reply.status(201).send({ ...membership, created_at: membership.created_at.toISOString() });
    },
  );

  app.get<{ Querystring: ListMembershipsQuery }>(
    "/jurisdiction/memberships",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["citizen_id"],
          properties: { citizen_id: { type: "string" } },
        },
      },
    },
    async (request) =>
      listMemberships(deps.store, request.query.citizen_id).map((m) => ({
        ...m,
        created_at: m.created_at.toISOString(),
      })),
  );
}
