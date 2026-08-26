import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import type { NotificationEmitter } from "../notifications.js";
import { recordParticipationScores, sweepInactivity } from "../services/participation.js";

const scoreBodySchema = {
  type: "object",
  required: ["period", "inputs"],
  additionalProperties: false,
  properties: {
    period: { type: "string", pattern: "^\\d{4}-\\d{2}$" },
    inputs: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["citizen_id", "voting_count", "review_count", "audit_count", "quota_target"],
        additionalProperties: false,
        properties: {
          citizen_id: { type: "string", minLength: 1 },
          voting_count: { type: "number", minimum: 0 },
          review_count: { type: "number", minimum: 0 },
          audit_count: { type: "number", minimum: 0 },
          quota_target: { type: "number", minimum: 0 },
        },
      },
    },
  },
} as const;

const sweepBodySchema = {
  type: "object",
  required: ["period", "inactivity_threshold_score"],
  additionalProperties: false,
  properties: {
    period: { type: "string", pattern: "^\\d{4}-\\d{2}$" },
    inactivity_threshold_score: { type: "number" },
  },
} as const;

export function registerParticipationRoutes(app: FastifyInstance, store: Store, notifier: NotificationEmitter) {
  app.post<{
    Body: {
      period: string;
      inputs: {
        citizen_id: string;
        voting_count: number;
        review_count: number;
        audit_count: number;
        quota_target: number;
      }[];
    };
  }>("/civic-duty/participation/score", { schema: { body: scoreBodySchema } }, async (request) =>
    recordParticipationScores(
      store,
      request.body.period,
      request.body.inputs.map((input) => ({
        citizenId: input.citizen_id,
        votingCount: input.voting_count,
        reviewCount: input.review_count,
        auditCount: input.audit_count,
        quotaTarget: input.quota_target,
      })),
    ),
  );

  app.post<{ Body: { period: string; inactivity_threshold_score: number } }>(
    "/civic-duty/inactivity/sweep",
    { schema: { body: sweepBodySchema } },
    async (request) =>
      sweepInactivity(store, notifier, request.body.period, request.body.inactivity_threshold_score),
  );
}
