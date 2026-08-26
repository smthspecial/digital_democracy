import Fastify from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerCategoryRoutes } from "./routes/categories.js";
import { registerAllocationRoutes } from "./routes/allocations.js";
import { registerLedgerRoutes } from "./routes/ledger.js";
import { registerReconcileRoutes } from "./routes/reconcile.js";
import { createStore, type Store } from "./store.js";
import { DomainError } from "./errors.js";
import { noopAlertEmitter, type AlertEmitter } from "./services/reconciliation.js";

export interface Deps {
  store: Store;
  alertEmitter: AlertEmitter;
}

export function buildServer(deps?: Partial<Deps>) {
  const resolved: Deps = {
    store: deps?.store ?? createStore(),
    alertEmitter: deps?.alertEmitter ?? noopAlertEmitter,
  };

  const app = Fastify({ logger: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      reply.status(err.statusCode).send({ error: err.message });
      return;
    }
    if (err.validation) {
      reply.status(400).send({ error: err.message });
      return;
    }
    app.log.error(err);
    reply.status(500).send({ error: "internal server error" });
  });

  registerHealthRoutes(app);
  registerCategoryRoutes(app, resolved.store);
  registerAllocationRoutes(app, resolved.store);
  registerLedgerRoutes(app, resolved.store);
  registerReconcileRoutes(app, resolved.store, resolved.alertEmitter);

  return app;
}
