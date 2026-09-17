import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenDomainError, InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import type { GovernanceRoleChecker } from "../governance-role/governance-role-checker.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { IdentityRevocationService } from "./identity-revocation.service.js";

const urls = testDatabaseUrls();

async function withAdmin<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urls!.admin });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function insertCitizen(id: string, publicHandle: string, status: string = "active"): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO citizen (id, public_handle, legal_identity_hash, status) VALUES ($1, $2, $3, $4)`, [
      id,
      publicHandle,
      `hash-${id}`,
      status,
    ]),
  );
}

describe.skipIf(!urls)("IdentityRevocationService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let isOperator: boolean;
  let approved: boolean;
  let audit: { emit: ReturnType<typeof vi.fn> };
  let sessionRevoker: { revokeAll: ReturnType<typeof vi.fn> };
  let svc: IdentityRevocationService;
  let actorId: string;
  let citizenId: string;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    isOperator = true;
    approved = false;
    audit = { emit: vi.fn().mockResolvedValue(undefined) };
    sessionRevoker = { revokeAll: vi.fn().mockResolvedValue(undefined) };
    const governanceRole: GovernanceRoleChecker = { isActiveHolder: vi.fn(async () => isOperator) };
    const approvalGate = { isFullyApproved: vi.fn(async () => approved) };
    svc = new IdentityRevocationService(prisma, governanceRole, approvalGate, audit, sessionRevoker);

    actorId = randomUUID();
    citizenId = randomUUID();
    await insertCitizen(actorId, "operator-actor");
    await insertCitizen(citizenId, "target-citizen");
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  describe("request", () => {
    it("rejects a non-operator actor", async () => {
      isOperator = false;
      await expect(
        svc.request(actorId, { citizenId, reason: "proven_fraud", justification: "j" }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("rejects an unknown citizen", async () => {
      await expect(
        svc.request(actorId, { citizenId: randomUUID(), reason: "death", justification: "j" }),
      ).rejects.toBeInstanceOf(NotFoundDomainError);
    });

    it("rejects a citizen already revoked", async () => {
      const revokedId = randomUUID();
      await insertCitizen(revokedId, "already-revoked", "revoked");
      await expect(
        svc.request(actorId, { citizenId: revokedId, reason: "death", justification: "j" }),
      ).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    it("creates a pending revocation with the identity:revoke:{citizenId} action ref", async () => {
      const revocation = await svc.request(actorId, { citizenId, reason: "proven_fraud", justification: "evidence here" });
      expect(revocation.status).toBe("pending");
      expect(revocation.actionRef).toBe(`identity:revoke:${citizenId}`);
      expect(revocation.reason).toBe("proven_fraud");
    });
  });

  describe("execute", () => {
    it("throws NotFoundDomainError for an unknown action ref", async () => {
      await expect(svc.execute("identity:revoke:nope")).rejects.toBeInstanceOf(NotFoundDomainError);
    });

    it("rejects when the approval gate has not fully approved (fail-closed)", async () => {
      await svc.request(actorId, { citizenId, reason: "death", justification: "j" });
      approved = false;
      await expect(svc.execute(`identity:revoke:${citizenId}`)).rejects.toBeInstanceOf(InvalidStateDomainError);

      const citizen = await prisma.forWorker((tx) => tx.citizen.findUnique({ where: { id: citizenId } }));
      expect(citizen?.status).toBe("active");
    });

    it("sets citizen.status to revoked, marks the revocation executed, emits audit, and calls the session revoker once fully approved", async () => {
      await svc.request(actorId, { citizenId, reason: "loss_of_citizenship", justification: "j" });
      approved = true;

      const citizen = await svc.execute(`identity:revoke:${citizenId}`);

      expect(citizen.status).toBe("revoked");
      expect(audit.emit).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: "identity.citizen_revoked", payload: expect.objectContaining({ citizenId }) }),
      );
      expect(sessionRevoker.revokeAll).toHaveBeenCalledWith(citizenId);

      const revocation = await svc.findByActionRef(`identity:revoke:${citizenId}`);
      expect(revocation.status).toBe("executed");
      expect(revocation.executedAt).not.toBeNull();
    });

    it("rejects executing an already-executed revocation", async () => {
      await svc.request(actorId, { citizenId, reason: "death", justification: "j" });
      approved = true;
      await svc.execute(`identity:revoke:${citizenId}`);
      await expect(svc.execute(`identity:revoke:${citizenId}`)).rejects.toBeInstanceOf(InvalidStateDomainError);
    });
  });
});
