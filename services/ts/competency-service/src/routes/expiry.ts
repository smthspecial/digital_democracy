import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import { sweepExpiredCompetencies } from "../services/competency.js";
import type { NotificationEmitter } from "../integrations.js";

export function registerExpiryRoutes(
  app: FastifyInstance,
  store: Store,
  notificationEmitter: NotificationEmitter,
) {
  app.post("/competency/expiry-sweep", async () => {
    const expiredCount = sweepExpiredCompetencies(store, notificationEmitter);
    return { expired_count: expiredCount };
  });
}
