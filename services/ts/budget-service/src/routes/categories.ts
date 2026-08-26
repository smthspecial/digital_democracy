import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import { createCategory, getCategoryTree } from "../services/categories.js";

const createCategorySchema = {
  body: {
    type: "object",
    required: ["jurisdiction_id", "name"],
    properties: {
      jurisdiction_id: { type: "string" },
      parent_id: { type: ["string", "null"] },
      name: { type: "string", minLength: 1 },
    },
  },
};

export function registerCategoryRoutes(app: FastifyInstance, store: Store) {
  app.post<{
    Body: { jurisdiction_id: string; parent_id?: string | null; name: string };
  }>("/budget/categories", { schema: createCategorySchema }, async (req, reply) => {
    const category = createCategory(store, {
      jurisdictionId: req.body.jurisdiction_id,
      parentId: req.body.parent_id ?? null,
      name: req.body.name,
    });
    reply.status(201).send(category);
  });

  app.get<{ Params: { jurisdictionId: string } }>(
    "/budget/categories/:jurisdictionId/tree",
    async (req) => getCategoryTree(store, req.params.jurisdictionId),
  );
}
