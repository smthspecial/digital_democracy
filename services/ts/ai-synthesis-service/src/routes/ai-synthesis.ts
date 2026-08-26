import type { FastifyInstance } from "fastify";
import type { ArgumentInput, PreferenceInput } from "../domain/types.js";
import type { SynthesisStore } from "../store.js";
import type { AuditEmitter } from "../integrations/audit-emitter.js";
import { flagOutput, getOutput, listOutputsForProposal, synthesize, toggle } from "../services/ai-synthesis.js";

const argumentSchema = {
  type: "object",
  required: ["content", "stance"],
  additionalProperties: false,
  properties: {
    content: { type: "string", minLength: 1 },
    stance: { type: "string", enum: ["agreement", "disagreement"] },
    evidence_ref: { type: "string" },
  },
};

const preferenceSchema = {
  type: "object",
  required: ["description"],
  additionalProperties: false,
  properties: {
    description: { type: "string", minLength: 1 },
  },
};

const synthesizeSchema = {
  body: {
    type: "object",
    required: ["proposal_id", "arguments", "preferences"],
    additionalProperties: false,
    properties: {
      proposal_id: { type: "string", minLength: 1 },
      arguments: { type: "array", items: argumentSchema },
      preferences: { type: "array", items: preferenceSchema },
    },
  },
};

const toggleSchema = {
  body: {
    type: "object",
    required: ["enabled"],
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
    },
  },
};

const flagSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", minLength: 1 } },
  },
  body: {
    type: "object",
    required: ["citizen_id", "reason"],
    additionalProperties: false,
    properties: {
      citizen_id: { type: "string", minLength: 1 },
      reason: { type: "string", minLength: 1 },
    },
  },
};

const outputIdParamsSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", minLength: 1 } },
  },
};

const proposalOutputsParamsSchema = {
  params: {
    type: "object",
    required: ["proposalId"],
    properties: { proposalId: { type: "string", minLength: 1 } },
  },
};

interface SynthesizeBody {
  proposal_id: string;
  arguments: ArgumentInput[];
  preferences: PreferenceInput[];
}

interface ToggleBody {
  enabled: boolean;
}

interface FlagBody {
  citizen_id: string;
  reason: string;
}

export interface AiSynthesisDeps {
  store: SynthesisStore;
  auditEmitter: AuditEmitter;
}

export function registerAiSynthesisRoutes(app: FastifyInstance, deps: AiSynthesisDeps) {
  const { store, auditEmitter } = deps;

  app.post<{ Body: SynthesizeBody }>(
    "/ai-synthesis/synthesize",
    { schema: synthesizeSchema },
    async (request) => synthesize(store, auditEmitter, request.body),
  );

  app.post<{ Body: ToggleBody }>(
    "/ai-synthesis/toggle",
    { schema: toggleSchema },
    async (request) => toggle(store, request.body.enabled),
  );

  app.post<{ Params: { id: string }; Body: FlagBody }>(
    "/ai-synthesis/outputs/:id/flag",
    { schema: flagSchema },
    async (request) => flagOutput(store, request.params.id, request.body.citizen_id, request.body.reason),
  );

  app.get<{ Params: { id: string } }>(
    "/ai-synthesis/outputs/:id",
    { schema: outputIdParamsSchema },
    async (request) => getOutput(store, request.params.id),
  );

  app.get<{ Params: { proposalId: string } }>(
    "/ai-synthesis/proposals/:proposalId/outputs",
    { schema: proposalOutputsParamsSchema },
    async (request) => listOutputsForProposal(store, request.params.proposalId),
  );
}
