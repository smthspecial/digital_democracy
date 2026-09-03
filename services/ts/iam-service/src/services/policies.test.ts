import { describe, expect, it } from "vitest";
import { createStore } from "../store.js";
import { defaultAuditEmitter } from "../collaborators.js";
import type { GovernanceRoleChecker } from "../collaborators.js";
import type { RoleType } from "../domain/types.js";
import { endorsePolicy, proposePolicy, revokePolicy } from "./policies.js";

const NOW = new Date("2026-03-01T00:00:00Z");

// A fake GovernanceRoleChecker backed by a plain citizenId -> roleTypes map,
// standing in for a live governance-role-service lookup in these unit tests
// (the real HTTP seam is exercised separately in collaborators.test.ts).
function checkerFor(grants: Record<string, RoleType[]>): GovernanceRoleChecker {
  return {
    hasActiveRole: (citizenId, roleType) => (grants[citizenId] ?? []).includes(roleType),
  };
}

const BASE_POLICY_INPUT = {
  name: "rotate-secrets",
  effect: "allow" as const,
  actions: ["secrets:rotate"],
  resources: ["secrets:*"],
  conditions: null,
  description: "allow rotating secrets",
};

describe("proposePolicy", () => {
  it("creates a pending_approval policy for a proposer holding an active operator role", async () => {
    const store = createStore();
    const checker = checkerFor({ "citizen-1": ["operator"] });

    const policy = await proposePolicy(
      store,
      checker,
      defaultAuditEmitter,
      { ...BASE_POLICY_INPUT, proposedBy: "citizen-1" },
      NOW,
    );

    expect(policy.status).toBe("pending_approval");
    expect(policy.proposedBy).toBe("citizen-1");
    expect(policy.proposerRoleType).toBe("operator");
  });

  it("pins proposerRoleType to platform_operator when that's the qualifying role", async () => {
    const store = createStore();
    const checker = checkerFor({ "citizen-1": ["platform_operator"] });

    const policy = await proposePolicy(
      store,
      checker,
      defaultAuditEmitter,
      { ...BASE_POLICY_INPUT, proposedBy: "citizen-1" },
      NOW,
    );

    expect(policy.proposerRoleType).toBe("platform_operator");
  });

  it("rejects a proposer holding neither operator nor platform_operator", async () => {
    const store = createStore();
    const checker = checkerFor({ "citizen-1": ["auditor"] });

    await expect(
      proposePolicy(store, checker, defaultAuditEmitter, { ...BASE_POLICY_INPUT, proposedBy: "citizen-1" }, NOW),
    ).rejects.toThrow(/operator or platform_operator/);
  });

  // RoleType is not exclusive (dual-control.ts's own comment: "a proposer can
  // legitimately hold *both* operator and platform_operator at once") --
  // GRANTOR_ROLE_TYPES is checked in a fixed order (operator first) purely to
  // make the pinned proposerRoleType deterministic for such a citizen. This
  // was previously untested: every other test here grants exactly one
  // qualifying role.
  it("pins proposerRoleType to operator (checked first) when the proposer holds both operator and platform_operator", async () => {
    const store = createStore();
    const checker = checkerFor({ "citizen-1": ["platform_operator", "operator"] });

    const policy = await proposePolicy(
      store,
      checker,
      defaultAuditEmitter,
      { ...BASE_POLICY_INPUT, proposedBy: "citizen-1" },
      NOW,
    );

    expect(policy.proposerRoleType).toBe("operator");
  });
});

describe("endorsePolicy", () => {
  async function proposedPolicy(store: ReturnType<typeof createStore>, checker: GovernanceRoleChecker) {
    return proposePolicy(store, checker, defaultAuditEmitter, { ...BASE_POLICY_INPUT, proposedBy: "citizen-1" }, NOW);
  }

  it("activates the policy on the dual-control happy path (different citizen, same role_type, approved)", async () => {
    const store = createStore();
    const checker = checkerFor({ "citizen-1": ["operator"], "citizen-2": ["operator"] });
    const policy = await proposedPolicy(store, checker);

    const result = await endorsePolicy(
      store,
      checker,
      defaultAuditEmitter,
      policy.id,
      { endorserCitizenId: "citizen-2", decision: "approved" },
      NOW,
    );

    expect(result.policy.status).toBe("active");
    expect(result.endorsement.decision).toBe("approved");
    expect(result.endorsement.endorserCitizenId).toBe("citizen-2");
  });

  it("flips the policy to rejected on a rejected decision", async () => {
    const store = createStore();
    const checker = checkerFor({ "citizen-1": ["operator"], "citizen-2": ["operator"] });
    const policy = await proposedPolicy(store, checker);

    const result = await endorsePolicy(
      store,
      checker,
      defaultAuditEmitter,
      policy.id,
      { endorserCitizenId: "citizen-2", decision: "rejected" },
      NOW,
    );

    expect(result.policy.status).toBe("rejected");
  });

  it("rejects the proposer endorsing their own policy", async () => {
    const store = createStore();
    const checker = checkerFor({ "citizen-1": ["operator"] });
    const policy = await proposedPolicy(store, checker);

    await expect(
      endorsePolicy(store, checker, defaultAuditEmitter, policy.id, { endorserCitizenId: "citizen-1", decision: "approved" }, NOW),
    ).rejects.toThrow(/different citizen/);
  });

  it("rejects an endorser holding a different role_type than the proposer", async () => {
    const store = createStore();
    const checker = checkerFor({ "citizen-1": ["operator"], "citizen-2": ["platform_operator"] });
    const policy = await proposedPolicy(store, checker);

    await expect(
      endorsePolicy(store, checker, defaultAuditEmitter, policy.id, { endorserCitizenId: "citizen-2", decision: "approved" }, NOW),
    ).rejects.toThrow(/same role_type|operator governance role/);
  });

  it("rejects a second endorsement from the same citizen", async () => {
    const store = createStore();
    const checker = checkerFor({ "citizen-1": ["operator"], "citizen-2": ["operator"], "citizen-3": ["operator"] });
    const policy = await proposedPolicy(store, checker);

    await endorsePolicy(store, checker, defaultAuditEmitter, policy.id, { endorserCitizenId: "citizen-2", decision: "rejected" }, NOW);

    // Even a distinct decision from the same citizen on the same target is
    // rejected -- one endorsement per citizen per target (TBL-042 UNIQUE).
    await expect(
      endorsePolicy(store, checker, defaultAuditEmitter, policy.id, { endorserCitizenId: "citizen-2", decision: "approved" }, NOW),
    ).rejects.toThrow(/already submitted/);
  });

  it("rejects endorsing a policy that is no longer pending_approval", async () => {
    const store = createStore();
    const checker = checkerFor({ "citizen-1": ["operator"], "citizen-2": ["operator"], "citizen-3": ["operator"] });
    const policy = await proposedPolicy(store, checker);
    await endorsePolicy(store, checker, defaultAuditEmitter, policy.id, { endorserCitizenId: "citizen-2", decision: "approved" }, NOW);

    await expect(
      endorsePolicy(store, checker, defaultAuditEmitter, policy.id, { endorserCitizenId: "citizen-3", decision: "approved" }, NOW),
    ).rejects.toThrow(/not pending approval/);
  });

  it("rejects endorsing a nonexistent policy with a 404", async () => {
    const store = createStore();
    const checker = checkerFor({ "citizen-2": ["operator"] });

    await expect(
      endorsePolicy(store, checker, defaultAuditEmitter, "missing-policy", { endorserCitizenId: "citizen-2", decision: "approved" }, NOW),
    ).rejects.toThrow(/no access_policy/);
  });
});

describe("revokePolicy", () => {
  it("does not require dual control -- a single auditor may revoke unilaterally", async () => {
    const store = createStore();
    const proposeChecker = checkerFor({ "citizen-1": ["operator"], "citizen-2": ["operator"] });
    const policy = await proposePolicy(store, proposeChecker, defaultAuditEmitter, { ...BASE_POLICY_INPUT, proposedBy: "citizen-1" }, NOW);
    await endorsePolicy(store, proposeChecker, defaultAuditEmitter, policy.id, { endorserCitizenId: "citizen-2", decision: "approved" }, NOW);

    const revokerChecker = checkerFor({ "citizen-9": ["auditor"] });
    const revoked = await revokePolicy(store, revokerChecker, defaultAuditEmitter, policy.id, { revokedBy: "citizen-9" }, NOW);

    expect(revoked.status).toBe("revoked");
  });

  it("allows revoking a still-pending_approval policy", async () => {
    const store = createStore();
    const proposeChecker = checkerFor({ "citizen-1": ["operator"] });
    const policy = await proposePolicy(store, proposeChecker, defaultAuditEmitter, { ...BASE_POLICY_INPUT, proposedBy: "citizen-1" }, NOW);

    const revokerChecker = checkerFor({ "citizen-9": ["platform_operator"] });
    const revoked = await revokePolicy(store, revokerChecker, defaultAuditEmitter, policy.id, { revokedBy: "citizen-9" }, NOW);

    expect(revoked.status).toBe("revoked");
  });

  it("rejects a revoker holding none of operator/platform_operator/auditor", async () => {
    const store = createStore();
    const proposeChecker = checkerFor({ "citizen-1": ["operator"] });
    const policy = await proposePolicy(store, proposeChecker, defaultAuditEmitter, { ...BASE_POLICY_INPUT, proposedBy: "citizen-1" }, NOW);

    const revokerChecker = checkerFor({ "citizen-9": ["reviewer"] });
    await expect(
      revokePolicy(store, revokerChecker, defaultAuditEmitter, policy.id, { revokedBy: "citizen-9" }, NOW),
    ).rejects.toThrow(/operator, platform_operator, or auditor/);
  });

  it("rejects revoking a nonexistent policy with a 404", async () => {
    const store = createStore();
    const revokerChecker = checkerFor({ "citizen-9": ["auditor"] });

    await expect(
      revokePolicy(store, revokerChecker, defaultAuditEmitter, "missing-policy", { revokedBy: "citizen-9" }, NOW),
    ).rejects.toThrow(/no access_policy/);
  });

  // DP-072's trigger condition is explicitly "active or pending_approval" --
  // an already-terminal policy (revoked, or rejected via dual-control veto)
  // must not be revocable a second time. Neither terminal status was
  // previously exercised here.
  it("rejects revoking an already-revoked policy", async () => {
    const store = createStore();
    const proposeChecker = checkerFor({ "citizen-1": ["operator"] });
    const policy = await proposePolicy(store, proposeChecker, defaultAuditEmitter, { ...BASE_POLICY_INPUT, proposedBy: "citizen-1" }, NOW);

    const revokerChecker = checkerFor({ "citizen-9": ["auditor"] });
    await revokePolicy(store, revokerChecker, defaultAuditEmitter, policy.id, { revokedBy: "citizen-9" }, NOW);

    await expect(
      revokePolicy(store, revokerChecker, defaultAuditEmitter, policy.id, { revokedBy: "citizen-9" }, NOW),
    ).rejects.toThrow(/cannot revoke access_policy/);
  });

  it("rejects revoking an already-rejected policy", async () => {
    const store = createStore();
    const checker = checkerFor({ "citizen-1": ["operator"], "citizen-2": ["operator"], "citizen-9": ["auditor"] });
    const policy = await proposePolicy(store, checker, defaultAuditEmitter, { ...BASE_POLICY_INPUT, proposedBy: "citizen-1" }, NOW);
    await endorsePolicy(store, checker, defaultAuditEmitter, policy.id, { endorserCitizenId: "citizen-2", decision: "rejected" }, NOW);

    await expect(
      revokePolicy(store, checker, defaultAuditEmitter, policy.id, { revokedBy: "citizen-9" }, NOW),
    ).rejects.toThrow(/cannot revoke access_policy/);
  });
});
