import type { FastifyInstance } from "fastify";
import type { Store } from "../store.js";
import { submitChallenge, resolveChallenge } from "../services/challenges.js";
import { serializeChallenge } from "../serializers.js";
import type { ReputationEmitter } from "../integrations.js";

const submitSchema = {
  body: {
    type: "object",
    required: ["competency_id", "challenger_id", "reason", "evidence_ref"],
    additionalProperties: false,
    properties: {
      competency_id: { type: "string", minLength: 1 },
      challenger_id: { type: "string", minLength: 1 },
      reason: { type: "string", enum: ["credentials", "conflict", "false_claim", "misconduct"] },
      evidence_ref: { type: "string", minLength: 1 },
    },
  },
} as const;

const resolveSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", minLength: 1 } },
  },
  body: {
    type: "object",
    required: ["result"],
    additionalProperties: false,
    properties: {
      result: { type: "string", enum: ["upheld", "dismissed"] },
    },
  },
} as const;

export function registerChallengeRoutes(
  app: FastifyInstance,
  store: Store,
  reputationEmitter: ReputationEmitter,
) {
  app.post<{
    Body: {
      competency_id: string;
      challenger_id: string;
      reason: "credentials" | "conflict" | "false_claim" | "misconduct";
      evidence_ref: string;
    };
  }>("/competency/challenges", { schema: submitSchema }, async (request, reply) => {
    const challenge = submitChallenge(store, {
      competencyId: request.body.competency_id,
      challengerId: request.body.challenger_id,
      reason: request.body.reason,
      evidenceRef: request.body.evidence_ref,
    });
    reply.code(201);
    return serializeChallenge(challenge);
  });

  app.post<{ Params: { id: string }; Body: { result: "upheld" | "dismissed" } }>(
    "/competency/challenges/:id/resolve",
    { schema: resolveSchema },
    async (request) => {
      const challenge = resolveChallenge(store, reputationEmitter, request.params.id, request.body.result);
      return serializeChallenge(challenge);
    },
  );
}
