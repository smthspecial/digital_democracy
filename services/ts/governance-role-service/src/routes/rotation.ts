import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps.js";
import { serializeRole } from "../serializers.js";
import { sweepRotation } from "../services/rotation.js";

interface SweepBody {
  now?: string;
}

const sweepBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    now: { type: "string", format: "date-time" },
  },
} as const;

export function registerRotationRoutes(app: FastifyInstance, deps: Deps) {
  app.post<{ Body: SweepBody }>(
    "/governance-roles/rotation/sweep",
    { schema: { body: sweepBodySchema } },
    async (req) => {
      const now = req.body?.now ? new Date(req.body.now) : new Date();
      const result = sweepRotation(deps.store, deps.notificationEmitter, deps.replacementRequester, deps.auditEmitter, now);
      return {
        flagged: result.flagged.map(serializeRole),
        flagged_count: result.flagged.length,
      };
    },
  );
}
