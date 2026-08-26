import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ServiceDeps } from "../deps.js";
import type { Citizen } from "../repositories/citizen.js";

const submitVerificationSchema = z.object({
  citizenId: z.string().uuid(),
  method: z.enum(["national_id", "passport", "gov_credential"]),
  evidenceRef: z.string().min(1),
});

// DP-002: Submit identity verification evidence (POST /verifications).
// On approval, activates the citizen (DP-001 -> pending, here -> active)
// and runs the DP-024 duplicate check.
export function registerVerificationRoutes(app: FastifyInstance, deps: ServiceDeps) {
  app.post("/verifications", async (request, reply) => {
    const parsed = submitVerificationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_request", details: parsed.error.flatten() });
    }
    const { citizenId, method, evidenceRef } = parsed.data;

    const citizen = await deps.citizenRepo.findById(citizenId);
    if (!citizen) return reply.code(404).send({ error: "citizen_not_found" });
    if (citizen.status !== "pending") {
      return reply.code(409).send({
        error: "not_pending",
        message: "Citizen identity is not awaiting verification.",
      });
    }

    const outcome = await deps.verifyEvidence(method, evidenceRef);
    const verification = await deps.verificationRepo.create({
      citizenId,
      method,
      evidenceRef,
      status: outcome.approved ? "verified" : "rejected",
      verifiedAt: outcome.approved ? new Date() : undefined,
    });

    let resultingCitizen: Citizen = citizen;
    if (outcome.approved) {
      resultingCitizen = await deps.citizenRepo.updateStatus(citizenId, "active");
      await deps.events.publish({
        topic: "audit.append",
        payload: { type: "identity.activated", citizenId: resultingCitizen.id },
      });
      await runDuplicateCheck(deps, resultingCitizen);
    }

    return reply.code(201).send({
      id: verification.id,
      status: verification.status,
      citizenStatus: resultingCitizen.status,
    });
  });
}

// DP-024: Duplicate identity detection. The citizen_legal_identity_hash_live_idx
// unique index already rejects a colliding registration synchronously
// (FR-001); this is the async defense-in-depth pass DP-024 documents,
// covering cases the index can't (e.g. two records that later turn out to
// share a legal identity after re-hashing or manual correction).
async function runDuplicateCheck(deps: ServiceDeps, citizen: Citizen): Promise<void> {
  const others = await deps.citizenRepo.findLiveByLegalHash(citizen.legalIdentityHash, citizen.id);
  const activeOthers = others.filter((other) => other.status === "active");
  if (activeOthers.length === 0) return;

  await deps.events.publish({
    topic: "identity.check",
    payload: {
      type: "duplicate_identity_detected",
      citizenIds: [citizen.id, ...activeOthers.map((other) => other.id)],
    },
  });
}
