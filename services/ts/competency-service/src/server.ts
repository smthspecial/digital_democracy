import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoutes } from "./routes/health.js";
import { registerDomainRoutes } from "./routes/domains.js";
import { registerApplicationRoutes } from "./routes/applications.js";
import { registerCitizenRoutes } from "./routes/citizens.js";
import { registerConflictRoutes } from "./routes/conflicts.js";
import { registerAssessmentRoutes } from "./routes/assessments.js";
import { registerChallengeRoutes } from "./routes/challenges.js";
import { registerExpiryRoutes } from "./routes/expiry.js";
import { createStore, type Store } from "./store.js";
import {
  noopExclusionEnforcer,
  noopNotificationEmitter,
  type ExclusionEnforcer,
  type NotificationEmitter,
} from "./integrations.js";
import { DomainError } from "./errors.js";

export interface Deps {
  store: Store;
  exclusionEnforcer: ExclusionEnforcer;
  notificationEmitter: NotificationEmitter;
}

export function buildServer(deps: Partial<Deps> = {}): FastifyInstance {
  const store = deps.store ?? createStore();
  const exclusionEnforcer = deps.exclusionEnforcer ?? noopExclusionEnforcer;
  const notificationEmitter = deps.notificationEmitter ?? noopNotificationEmitter;

  const app = Fastify({ logger: true });
  registerHealthRoutes(app);
  registerDomainRoutes(app, store);
  registerApplicationRoutes(app, store);
  registerCitizenRoutes(app, store);
  registerConflictRoutes(app, store, exclusionEnforcer);
  registerAssessmentRoutes(app, store);
  registerChallengeRoutes(app, store);
  registerExpiryRoutes(app, store, notificationEmitter);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    if (error.validation) {
      reply.code(400).send({ error: error.message });
      return;
    }
    request.log.error(error);
    reply.code(500).send({ error: "internal server error" });
  });

  return app;
}
