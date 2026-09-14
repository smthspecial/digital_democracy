import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenDomainError, InvalidStateDomainError, NotFoundDomainError } from "../common/domain-errors.js";
import type { GovernanceRoleChecker } from "../governance-role/governance-role-checker.port.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { newTestPrismaService, TestDatabaseUrls, testDatabaseUrls, truncateAll } from "../test-support/postgres.js";
import { IamService } from "./iam.service.js";

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

async function insertCitizen(id: string, publicHandle: string): Promise<void> {
  await withAdmin((client) =>
    client.query(`INSERT INTO citizen (id, public_handle, legal_identity_hash) VALUES ($1, $2, $3)`, [
      id,
      publicHandle,
      `hash-${id}`,
    ]),
  );
}

const POLICY_INPUT = {
  name: "Allow secret rotation",
  effect: "allow" as const,
  actions: ["secrets:rotate"],
  resources: ["*"],
  description: "Lets platform-operators rotate secrets",
};

// Real-Postgres pass: connects as api_app/api_worker (not a superuser), so
// this exercises access_policy/policy_attachment/policy_endorsement's RLS
// policies rather than just their SQL text, mirroring
// project.service.spec.ts. IamService now owns its Prisma calls directly (no
// repository indirection) -- these tests drive it through its public API
// only, not internal query helpers. GOVERNANCE_ROLE_CHECKER remains a fake
// (unrelated to persistence).
describe.skipIf(!urls)("IamService (Postgres, RLS-enforced)", () => {
  let prisma: PrismaService;
  let svc: IamService;
  let governanceRole: GovernanceRoleChecker;
  let audit: { emit: ReturnType<typeof vi.fn> };
  let PROPOSER: string;
  let ENDORSER: string;
  let OTHER_TYPE_HOLDER: string;
  let NOBODY: string;
  let holders: Map<string, string[]>;

  beforeEach(async () => {
    await truncateAll(urls as TestDatabaseUrls);
    prisma = newTestPrismaService(urls as TestDatabaseUrls);
    await prisma.onModuleInit();

    PROPOSER = randomUUID();
    ENDORSER = randomUUID();
    OTHER_TYPE_HOLDER = randomUUID();
    NOBODY = randomUUID();

    holders = new Map<string, string[]>([
      [PROPOSER, ["operator"]],
      [ENDORSER, ["operator"]],
      [OTHER_TYPE_HOLDER, ["platform_operator"]],
    ]);
    governanceRole = {
      isActiveHolder: vi.fn(async (citizenId: string, roleType: string) => holders.get(citizenId)?.includes(roleType) ?? false),
    };
    audit = { emit: vi.fn().mockResolvedValue(undefined) };
    svc = new IamService(prisma, governanceRole, audit);

    await insertCitizen(PROPOSER, "proposer");
    await insertCitizen(ENDORSER, "endorser");
    await insertCitizen(OTHER_TYPE_HOLDER, "other-type-holder");
    await insertCitizen(NOBODY, "nobody");
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  describe("proposePolicy (DP-069)", () => {
    it("rejects a proposer with no operator/platform_operator role", async () => {
      await expect(svc.proposePolicy(NOBODY, POLICY_INPUT)).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("creates a pending_approval policy and emits exactly one audit event", async () => {
      const policy = await svc.proposePolicy(PROPOSER, POLICY_INPUT);
      expect(policy.status).toBe("pending_approval");
      expect(policy.proposedBy).toBe(PROPOSER);
      expect(audit.emit).toHaveBeenCalledTimes(1);
    });
  });

  describe("submitEndorsement (DP-070)", () => {
    it("rejects self-endorsement", async () => {
      const policy = await svc.proposePolicy(PROPOSER, POLICY_INPUT);
      await expect(
        svc.submitEndorsement(PROPOSER, { targetType: "policy", targetId: policy.id, decision: "approved" }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("rejects an endorser who holds no role of the proposer's type", async () => {
      const policy = await svc.proposePolicy(PROPOSER, POLICY_INPUT);
      await expect(
        svc.submitEndorsement(OTHER_TYPE_HOLDER, { targetType: "policy", targetId: policy.id, decision: "approved" }),
      ).rejects.toBeInstanceOf(ForbiddenDomainError);
    });

    it("activates the policy on the first approved endorsement from a different, same-type role holder", async () => {
      const policy = await svc.proposePolicy(PROPOSER, POLICY_INPUT);
      const updated = await svc.submitEndorsement(ENDORSER, {
        targetType: "policy",
        targetId: policy.id,
        decision: "approved",
      });
      expect(updated.status).toBe("active");
      expect(audit.emit).toHaveBeenCalledTimes(2); // propose + endorse
    });

    it("rejects (not activates) the policy on a rejected endorsement", async () => {
      const policy = await svc.proposePolicy(PROPOSER, POLICY_INPUT);
      const updated = await svc.submitEndorsement(ENDORSER, {
        targetType: "policy",
        targetId: policy.id,
        decision: "rejected",
      });
      expect(updated.status).toBe("rejected");
    });

    it("rejects endorsing a target that is no longer pending_approval", async () => {
      const thirdOperator = randomUUID();
      await insertCitizen(thirdOperator, "third-operator");
      holders.set(thirdOperator, ["operator"]);

      const policy = await svc.proposePolicy(PROPOSER, POLICY_INPUT);
      await svc.submitEndorsement(ENDORSER, { targetType: "policy", targetId: policy.id, decision: "approved" });

      await expect(
        svc.submitEndorsement(thirdOperator, { targetType: "policy", targetId: policy.id, decision: "approved" }),
      ).rejects.toBeInstanceOf(InvalidStateDomainError);
    });

    // The old repository-level "rejects a second endorsement from the same
    // citizen on the same target" case called repo.insertEndorsement twice
    // directly, bypassing submitEndorsement's own pending_approval guard.
    // Through the public API that guard always fires first -- the target
    // flips off pending_approval on the very first endorsement, so a
    // same-citizen repeat always surfaces as InvalidStateDomainError, never
    // reaches the @@unique([targetType, targetId, endorserCitizenId])
    // constraint. No path reachable through the service's public API
    // exercises that constraint's ConflictDomainError mapping, so (per the
    // project.service.spec.ts precedent for the same situation) this
    // coverage is dropped rather than contrived.

    it("throws NotFoundDomainError for a nonexistent target", async () => {
      await expect(
        svc.submitEndorsement(ENDORSER, { targetType: "policy", targetId: randomUUID(), decision: "approved" }),
      ).rejects.toBeInstanceOf(NotFoundDomainError);
    });
  });

  describe("revoke (DP-072)", () => {
    it("rejects a revoker with no operator/platform_operator/auditor role", async () => {
      const policy = await svc.proposePolicy(PROPOSER, POLICY_INPUT);
      await expect(svc.revoke(NOBODY, { targetType: "policy", targetId: policy.id })).rejects.toBeInstanceOf(
        ForbiddenDomainError,
      );
    });

    it("allows an auditor to unilaterally revoke, with no dual control required", async () => {
      const auditor = randomUUID();
      await insertCitizen(auditor, "auditor");
      holders.set(auditor, ["auditor"]);

      const policy = await svc.proposePolicy(PROPOSER, POLICY_INPUT);
      const updated = await svc.revoke(auditor, { targetType: "policy", targetId: policy.id });
      expect(updated.status).toBe("revoked");
    });

    it("rejects revoking an already-revoked target", async () => {
      const auditor = randomUUID();
      await insertCitizen(auditor, "auditor");
      holders.set(auditor, ["auditor"]);

      const policy = await svc.proposePolicy(PROPOSER, POLICY_INPUT);
      await svc.revoke(auditor, { targetType: "policy", targetId: policy.id });
      await expect(svc.revoke(auditor, { targetType: "policy", targetId: policy.id })).rejects.toBeInstanceOf(
        InvalidStateDomainError,
      );
    });
  });

  describe("evaluate (DP-071)", () => {
    async function activePolicyAndAttachment(
      overrides?: Partial<typeof POLICY_INPUT>,
      principalRef = `citizen:${PROPOSER}`,
    ) {
      const policy = await svc.proposePolicy(PROPOSER, { ...POLICY_INPUT, ...overrides });
      await svc.submitEndorsement(ENDORSER, { targetType: "policy", targetId: policy.id, decision: "approved" });
      const attachment = await svc.proposeAttachment(PROPOSER, { policyId: policy.id, principalRef });
      await svc.submitEndorsement(ENDORSER, { targetType: "attachment", targetId: attachment.id, decision: "approved" });
      return { policy, attachment };
    }

    it("allows when a matching active allow policy is attached to the exact principal", async () => {
      await activePolicyAndAttachment();

      const result = await svc.evaluate({ principalRef: `citizen:${PROPOSER}`, action: "secrets:rotate", resource: "any" });
      expect(result.effect).toBe("allow");
    });

    it("defaults to deny when no policy matches", async () => {
      await activePolicyAndAttachment();

      const result = await svc.evaluate({ principalRef: `citizen:${PROPOSER}`, action: "k8s:deploy", resource: "any" });
      expect(result.effect).toBe("deny");
      expect(result.matchedPolicyId).toBeNull();
    });

    it("supports trailing-* wildcard action/resource matching", async () => {
      await activePolicyAndAttachment({ actions: ["secrets:*"], resources: ["*"] });

      const result = await svc.evaluate({
        principalRef: `citizen:${PROPOSER}`,
        action: "secrets:rotate",
        resource: "cluster-1",
      });
      expect(result.effect).toBe("allow");
    });

    it("an explicit deny always overrides a matching allow", async () => {
      await activePolicyAndAttachment({ effect: "allow" });
      await activePolicyAndAttachment({ effect: "deny", name: "Deny secret rotation" });

      const result = await svc.evaluate({ principalRef: `citizen:${PROPOSER}`, action: "secrets:rotate", resource: "any" });
      expect(result.effect).toBe("deny");
    });

    it("expands a role:operator attachment to every citizen currently, actively holding that role", async () => {
      const policy = await svc.proposePolicy(PROPOSER, POLICY_INPUT);
      await svc.submitEndorsement(ENDORSER, { targetType: "policy", targetId: policy.id, decision: "approved" });
      const attachment = await svc.proposeAttachment(PROPOSER, { policyId: policy.id, principalRef: "role:operator" });
      await svc.submitEndorsement(ENDORSER, { targetType: "attachment", targetId: attachment.id, decision: "approved" });

      // ENDORSER also holds "operator" per the seeded holders map, so the role-wide attachment applies to them too.
      const result = await svc.evaluate({ principalRef: `citizen:${ENDORSER}`, action: "secrets:rotate", resource: "any" });
      expect(result.effect).toBe("allow");
    });

    it("respects a policy's conditions against the request context", async () => {
      await activePolicyAndAttachment({ conditions: { environment: "staging" } });

      const matching = await svc.evaluate({
        principalRef: `citizen:${PROPOSER}`,
        action: "secrets:rotate",
        resource: "any",
        context: { environment: "staging" },
      });
      expect(matching.effect).toBe("allow");

      const nonMatching = await svc.evaluate({
        principalRef: `citizen:${PROPOSER}`,
        action: "secrets:rotate",
        resource: "any",
        context: { environment: "production" },
      });
      expect(nonMatching.effect).toBe("deny");
    });
  });
});
