import Fastify from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerNotificationRoutes } from "./routes/notifications.js";
import { createStore, type Store } from "./store.js";
import { defaultProviders, type Providers } from "./services/providers.js";
import { DomainError } from "./errors.js";

export interface Deps {
  store: Store;
  providers: Providers;
}

export function buildServer(deps?: Partial<Deps>) {
  const app = Fastify({ logger: true });
  const store = deps?.store ?? createStore();
  const providers = deps?.providers ?? defaultProviders();

  registerHealthRoutes(app);
  registerNotificationRoutes(app, { store, providers });

  app.setErrorHandler((err, _request, reply) => {
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

  return app;
}
