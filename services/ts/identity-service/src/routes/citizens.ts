import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServiceDeps } from "../deps.js";
import { generatePublicHandle } from "../handle.js";
import { hashLegalIdentifier } from "../hash.js";
import { DuplicateIdentityError } from "../repositories/errors.js";
import type { Citizen } from "../repositories/citizen.js";

const registerCitizenSchema = z.object({
  legalIdentifier: z.string().min(1),
});

// DP-001: Register civic identity (POST /citizens, unauthenticated).
export function registerCitizenRoutes(app: FastifyInstance, deps: ServiceDeps) {
  app.post("/citizens", async (request, reply) => {
    const parsed = registerCitizenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }

    const legalIdentityHash = hashLegalIdentifier(parsed.data.legalIdentifier, deps.identityHashSecret);

    try {
      const citizen = await deps.citizenRepo.create({
        publicHandle: generatePublicHandle(),
        legalIdentityHash,
      });
      return reply.code(201).send(toPublicCitizen(citizen));
    } catch (err) {
      if (err instanceof DuplicateIdentityError) {
        return reply.code(409).send({ error: "duplicate_identity", message: err.message });
      }
      throw err;
    }
  });

  app.get("/citizens/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const citizen = await deps.citizenRepo.findById(id);
    if (!citizen) return reply.code(404).send({ error: "not_found" });
    return toPublicCitizen(citizen);
  });
}

// NFR-006: legal_identity_hash and citizenship_status internals never leave
// this boundary in a public response.
function toPublicCitizen(citizen: Citizen) {
  return {
    id: citizen.id,
    publicHandle: citizen.publicHandle,
    status: citizen.status,
    createdAt: citizen.createdAt.toISOString(),
  };
}
