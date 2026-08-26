import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import type { Providers } from "../services/providers.js";
import type { Channel, NotificationRecord } from "../domain/types.js";
import { dispatchNotification, retryNotification } from "../services/notifications.js";
import { updatePreferences } from "../services/preferences.js";
import { CHANNELS } from "../domain/types.js";

export interface NotificationRouteDeps {
  store: Store;
  providers: Providers;
}

const dispatchBodySchema = {
  type: "object",
  required: ["citizen_id", "event_type", "channel", "payload"],
  additionalProperties: false,
  properties: {
    citizen_id: { type: "string", minLength: 1 },
    event_type: { type: "string", minLength: 1 },
    channel: { type: "string", enum: [...CHANNELS] },
    payload: { type: "object" },
  },
} as const;

function serializeNotification(record: NotificationRecord) {
  return {
    id: record.id,
    citizen_id: record.citizenId,
    event_type: record.eventType,
    channel: record.channel,
    payload: record.payload,
    status: record.status,
    attempts: record.attempts,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  };
}

export function registerNotificationRoutes(app: FastifyInstance, deps: NotificationRouteDeps) {
  const { store, providers } = deps;

  app.post(
    "/notifications/dispatch",
    { schema: { body: dispatchBodySchema } },
    async (request, reply) => {
      const body = request.body as {
        citizen_id: string;
        event_type: string;
        channel: Channel;
        payload: Record<string, unknown>;
      };
      const record = await dispatchNotification(store, providers, {
        citizenId: body.citizen_id,
        eventType: body.event_type,
        channel: body.channel,
        payload: body.payload,
      });
      reply.status(202).send(serializeNotification(record));
    },
  );

  app.post("/notifications/:id/retry", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = await retryNotification(store, providers, id);
    reply.status(200).send(serializeNotification(record));
  });

  app.put("/notifications/preferences/:citizenId", async (request, reply) => {
    const { citizenId } = request.params as { citizenId: string };
    const preferences = updatePreferences(store, citizenId, request.body as Record<string, unknown>);
    reply.status(200).send({ citizen_id: citizenId, preferences });
  });

  app.get("/notifications/citizens/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.status(200).send(store.listByCitizen(id).map(serializeNotification));
  });
}
