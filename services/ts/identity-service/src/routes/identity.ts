import type { FastifyInstance } from "fastify";
import type { Citizen, IdentityVerification, VerificationMethod } from "../domain/types.js";
import {
  type IdentityServiceDeps,
  getCitizen,
  listCitizens,
  registerCitizen,
  revokeCitizen,
  scanForDuplicates,
  submitVerification,
  suspendCitizen,
} from "../services/identity.js";

interface RegisterCitizenBody {
  public_handle: string;
  raw_legal_identifier: string;
}

interface SubmitVerificationBody {
  evidence_ref: string;
  outcome: "verified" | "rejected";
  method?: VerificationMethod;
}

interface CitizenParams {
  id: string;
}

const citizenParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
} as const;

function serializeCitizen(citizen: Citizen) {
  return {
    id: citizen.id,
    public_handle: citizen.publicHandle,
    status: citizen.status,
    created_at: citizen.createdAt.toISOString(),
  };
}

function serializeVerification(verification: IdentityVerification) {
  return {
    id: verification.id,
    citizen_id: verification.citizenId,
    method: verification.method,
    evidence_ref: verification.evidenceRef,
    status: verification.status,
    verified_at: verification.verifiedAt ? verification.verifiedAt.toISOString() : null,
  };
}

export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityServiceDeps) {
  app.post<{ Body: RegisterCitizenBody }>(
    "/identity/citizens",
    {
      schema: {
        body: {
          type: "object",
          required: ["public_handle", "raw_legal_identifier"],
          additionalProperties: false,
          properties: {
            public_handle: { type: "string", minLength: 1 },
            raw_legal_identifier: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const citizen = registerCitizen(deps, {
        publicHandle: request.body.public_handle,
        rawLegalIdentifier: request.body.raw_legal_identifier,
      });
      await reply.status(201).send(serializeCitizen(citizen));
    },
  );

  app.get("/identity/citizens", async () => listCitizens(deps).map(serializeCitizen));

  app.get<{ Params: CitizenParams }>(
    "/identity/citizens/:id",
    { schema: { params: citizenParamsSchema } },
    async (request) => serializeCitizen(getCitizen(deps, request.params.id)),
  );

  app.post<{ Params: CitizenParams; Body: SubmitVerificationBody }>(
    "/identity/citizens/:id/verifications",
    {
      schema: {
        params: citizenParamsSchema,
        body: {
          type: "object",
          required: ["evidence_ref", "outcome"],
          additionalProperties: false,
          properties: {
            evidence_ref: { type: "string", minLength: 1 },
            outcome: { type: "string", enum: ["verified", "rejected"] },
            method: { type: "string", enum: ["national_id", "passport", "gov_credential"] },
          },
        },
      },
    },
    async (request, reply) => {
      const verification = submitVerification(deps, request.params.id, {
        evidenceRef: request.body.evidence_ref,
        outcome: request.body.outcome,
        method: request.body.method,
      });
      await reply.status(201).send(serializeVerification(verification));
    },
  );

  app.post<{ Params: CitizenParams }>(
    "/identity/citizens/:id/suspend",
    { schema: { params: citizenParamsSchema } },
    async (request) => serializeCitizen(suspendCitizen(deps, request.params.id)),
  );

  app.post<{ Params: CitizenParams }>(
    "/identity/citizens/:id/revoke",
    { schema: { params: citizenParamsSchema } },
    async (request) => serializeCitizen(revokeCitizen(deps, request.params.id)),
  );

  app.post("/identity/duplicates/scan", async () => {
    const result = scanForDuplicates(deps);
    return {
      hash_matches: result.hashMatches.map((group) => ({
        legal_identity_hash: group.legalIdentityHash,
        citizen_ids: group.citizenIds,
      })),
      signal_matches: result.signalMatches.map((match) => ({
        citizen_id_a: match.citizenIdA,
        citizen_id_b: match.citizenIdB,
      })),
    };
  });
}
