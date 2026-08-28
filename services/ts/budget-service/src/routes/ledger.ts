import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import { recordLedgerEntry, listLedgerEntries } from "../services/ledger.js";

const recordSchema = {
  body: {
    type: "object",
    required: ["type", "amount", "description", "recorded_by"],
    properties: {
      category_id: { type: ["string", "null"] },
      project_id: { type: ["string", "null"] },
      type: { type: "string", enum: ["inflow", "outflow"] },
      amount: { type: "number" },
      description: { type: "string" },
      recorded_by: { type: "string" },
    },
  },
};

const listSchema = {
  querystring: {
    type: "object",
    properties: {
      category_id: { type: "string" },
      project_id: { type: "string" },
    },
  },
};

export function registerLedgerRoutes(app: FastifyInstance, store: Store) {
  app.post<{
    Body: {
      category_id?: string | null;
      project_id?: string | null;
      type: "inflow" | "outflow";
      amount: number;
      description: string;
      recorded_by: string;
    };
  }>("/budget/ledger", { schema: recordSchema }, async (req, reply) => {
    const entry = recordLedgerEntry(store, {
      categoryId: req.body.category_id ?? null,
      projectId: req.body.project_id ?? null,
      type: req.body.type,
      amount: req.body.amount,
      description: req.body.description,
      recordedBy: req.body.recorded_by,
    });
    reply.status(201).send(entry);
  });

  app.get<{ Querystring: { category_id?: string; project_id?: string } }>(
    "/budget/ledger",
    { schema: listSchema },
    async (req) => listLedgerEntries(store, req.query.category_id, req.query.project_id),
  );
}
