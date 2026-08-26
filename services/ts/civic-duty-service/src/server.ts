import Fastify from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAssignmentRoutes } from "./routes/assignments.js";
import { registerParticipationRoutes } from "./routes/participation.js";
import { createStore, type Store } from "./store.js";
import { DomainError } from "./errors.js";
import { noopNotificationEmitter, type NotificationEmitter } from "./notifications.js";
import type { RandomSource } from "./services/weighting.js";

export interface Deps {
  store: Store;
  random: RandomSource;
  notifier: NotificationEmitter;
}

export function buildServer(deps?: Partial<Deps>) {
  const resolved: Deps = {
    store: deps?.store ?? createStore(),
    random: deps?.random ?? Math.random,
    notifier: deps?.notifier ?? noopNotificationEmitter,
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
  registerAssignmentRoutes(app, resolved.store, resolved.random);
  registerParticipationRoutes(app, resolved.store, resolved.notifier);

  return app;
}
