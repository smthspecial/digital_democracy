import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import { createDomain, listDomains } from "../services/domains.js";
import { serializeDomain } from "../serializers.js";

const createDomainSchema = {
  body: {
    type: "object",
    required: ["name", "description"],
    additionalProperties: false,
    properties: {
      name: { type: "string", minLength: 1 },
      description: { type: "string", minLength: 1 },
    },
  },
} as const;

export function registerDomainRoutes(app: FastifyInstance, store: Store) {
  app.post<{ Body: { name: string; description: string } }>(
    "/competency/domains",
    { schema: createDomainSchema },
    async (request, reply) => {
      const domain = createDomain(store, request.body);
      reply.code(201);
      return serializeDomain(domain);
    },
  );

  app.get("/competency/domains", async () => {
    return listDomains(store).map(serializeDomain);
  });
}
