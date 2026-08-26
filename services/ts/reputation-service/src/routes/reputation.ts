import type { FastifyInstance } from "fastify";
import { FACTOR_TYPES, type FactorType, type ReputationRecord } from "../domain/types.js";
import {
  getCitizenRecords,
  getCitizenReputation,
  recordEvent,
  type ReputationDeps,
} from "../services/reputation.js";

interface CreateRecordBody {
  citizen_id: string;
  factor_type: FactorType;
  delta: number;
  source_ref?: string | null;
}

interface CitizenParams {
  id: string;
}

const createRecordSchema = {
  body: {
    type: "object",
    required: ["citizen_id", "factor_type", "delta"],
    additionalProperties: false,
    properties: {
      citizen_id: { type: "string", minLength: 1 },
      factor_type: { type: "string", enum: FACTOR_TYPES },
      delta: { type: "number" },
      source_ref: { type: ["string", "null"] },
    },
  },
} as const;

const citizenParamsSchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", minLength: 1 },
    },
  },
} as const;

function serializeRecord(record: ReputationRecord) {
  return {
    id: record.id,
    citizen_id: record.citizenId,
    factor_type: record.factorType,
    delta: record.delta,
    source_ref: record.sourceRef,
    created_at: record.createdAt.toISOString(),
  };
}

export function registerReputationRoutes(app: FastifyInstance, deps: ReputationDeps): void {
  app.post<{ Body: CreateRecordBody }>(
    "/reputation/records",
    { schema: createRecordSchema },
    async (request, reply) => {
      const { citizen_id, factor_type, delta, source_ref } = request.body;
      const record = recordEvent(deps, {
        citizenId: citizen_id,
        factorType: factor_type,
        delta,
        sourceRef: source_ref ?? null,
      });
      reply.code(201);
      return serializeRecord(record);
    },
  );

  app.get<{ Params: CitizenParams }>(
    "/reputation/citizens/:id",
    { schema: citizenParamsSchema },
    async (request) => {
      const { citizenId, total, records } = getCitizenReputation(deps.store, request.params.id);
      return {
        citizen_id: citizenId,
        total,
        records: records.map(serializeRecord),
      };
    },
  );

  app.get<{ Params: CitizenParams }>(
    "/reputation/citizens/:id/records",
    { schema: citizenParamsSchema },
    async (request) => {
      return getCitizenRecords(deps.store, request.params.id).map(serializeRecord);
    },
  );
}
