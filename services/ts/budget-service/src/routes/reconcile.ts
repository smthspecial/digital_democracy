import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import { reconcile, type AlertEmitter } from "../services/reconciliation.js";

const reconcileSchema = {
  body: {
    type: "object",
    properties: {
      period: { type: "string" },
    },
  },
};

export function registerReconcileRoutes(
  app: FastifyInstance,
  store: Store,
  alertEmitter: AlertEmitter,
) {
  app.post(
    "/budget/reconcile",
    { schema: reconcileSchema },
    async () => reconcile(store, alertEmitter),
  );
}
