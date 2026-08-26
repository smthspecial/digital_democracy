import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import { submitAllocations, aggregateAllocations } from "../services/allocations.js";

const submitSchema = {
  body: {
    type: "object",
    required: ["citizen_id", "period", "allocations"],
    properties: {
      citizen_id: { type: "string" },
      period: { type: "string" },
      allocations: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["category_id", "percentage"],
          properties: {
            category_id: { type: "string" },
            percentage: { type: "number" },
          },
        },
      },
    },
  },
};

const aggregateSchema = {
  body: {
    type: "object",
    required: ["period", "total_pool"],
    properties: {
      period: { type: "string" },
      total_pool: { type: "number" },
    },
  },
};

export function registerAllocationRoutes(app: FastifyInstance, store: Store) {
  app.post<{
    Body: {
      citizen_id: string;
      period: string;
      allocations: { category_id: string; percentage: number }[];
    };
  }>("/budget/allocations", { schema: submitSchema }, async (req, reply) => {
    const votes = submitAllocations(store, {
      citizenId: req.body.citizen_id,
      period: req.body.period,
      allocations: req.body.allocations.map((a) => ({
        categoryId: a.category_id,
        percentage: a.percentage,
      })),
    });
    reply.status(201).send(votes);
  });

  app.post<{ Body: { period: string; total_pool: number } }>(
    "/budget/allocations/aggregate",
    { schema: aggregateSchema },
    async (req) => aggregateAllocations(store, req.body.period, req.body.total_pool),
  );
}
