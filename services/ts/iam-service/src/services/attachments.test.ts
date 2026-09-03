import { describe, expect, it } from "vitest";
import { createStore } from "../store.js";
import { defaultAuditEmitter } from "../collaborators.js";
import type { GovernanceRoleChecker } from "../collaborators.js";
import type { RoleType } from "../domain/types.js";
import { proposePolicy } from "./policies.js";
import { endorseAttachment, proposeAttachment, revokeAttachment } from "./attachments.js";

const NOW = new Date("2026-03-01T00:00:00Z");

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

async function activePolicyId(store: ReturnType<typeof createStore>, checker: GovernanceRoleChecker): Promise<string> {
  const policy = await proposePolicy(store, checker, defaultAuditEmitter, { ...BASE_POLICY_INPUT, proposedBy: "policy-proposer" }, NOW);
  return policy.id;
}

describe("proposeAttachment", () => {
  it("creates a pending_approval attachment for a proposer holding an active operator role", async () => {
    const store = createStore();
    const checker = checkerFor({ "policy-proposer": ["operator"], "citizen-1": ["operator"] });
    const policyId = await activePolicyId(store, checker);

    const attachment = await proposeAttachment(
      store,
      checker,
      defaultAuditEmitter,
      { policyId, principalRef: "citizen:abc", proposedBy: "citizen-1" },
      NOW,
    );

    expect(attachment.status).toBe("pending_approval");
    expect(attachment.proposerRoleType).toBe("operator");
  });

  it("rejects an attachment proposed against a nonexistent policy", async () => {
    const store = createStore();
    const checker = checkerFor({ "citizen-1": ["operator"] });

    await expect(
      proposeAttachment(store, checker, defaultAuditEmitter, { policyId: "missing", principalRef: "citizen:abc", proposedBy: "citizen-1" }, NOW),
    ).rejects.toThrow(/no access_policy/);
  });
});

describe("endorseAttachment", () => {
  it("activates the attachment on the dual-control happy path", async () => {
    const store = createStore();
    const checker = checkerFor({ "policy-proposer": ["operator"], "citizen-1": ["operator"], "citizen-2": ["operator"] });
    const policyId = await activePolicyId(store, checker);
    const attachment = await proposeAttachment(store, checker, defaultAuditEmitter, { policyId, principalRef: "citizen:abc", proposedBy: "citizen-1" }, NOW);

    const result = await endorseAttachment(store, checker, defaultAuditEmitter, attachment.id, { endorserCitizenId: "citizen-2", decision: "approved" }, NOW);

    expect(result.attachment.status).toBe("active");
  });

  it("rejects the proposer endorsing their own attachment", async () => {
    const store = createStore();
    const checker = checkerFor({ "policy-proposer": ["operator"], "citizen-1": ["operator"] });
    const policyId = await activePolicyId(store, checker);
    const attachment = await proposeAttachment(store, checker, defaultAuditEmitter, { policyId, principalRef: "citizen:abc", proposedBy: "citizen-1" }, NOW);

    await expect(
      endorseAttachment(store, checker, defaultAuditEmitter, attachment.id, { endorserCitizenId: "citizen-1", decision: "approved" }, NOW),
    ).rejects.toThrow(/different citizen/);
  });

  it("rejects an endorser holding a different role_type than the proposer", async () => {
    const store = createStore();
    const checker = checkerFor({ "policy-proposer": ["operator"], "citizen-1": ["operator"], "citizen-2": ["platform_operator"] });
    const policyId = await activePolicyId(store, checker);
    const attachment = await proposeAttachment(store, checker, defaultAuditEmitter, { policyId, principalRef: "citizen:abc", proposedBy: "citizen-1" }, NOW);

    await expect(
      endorseAttachment(store, checker, defaultAuditEmitter, attachment.id, { endorserCitizenId: "citizen-2", decision: "approved" }, NOW),
    ).rejects.toThrow(/operator governance role/);
  });

  // TBL-041's status enum has no 'rejected' value (unlike TBL-040's) --
  // db/migrations/0001_init.up.sql flags this gap explicitly. A rejected
  // endorsement decision is still recorded, but the attachment stays
  // pending_approval rather than reaching a status that doesn't exist.
  it("leaves the attachment pending_approval on a rejected endorsement decision (TBL-041 has no rejected status)", async () => {
    const store = createStore();
    const checker = checkerFor({ "policy-proposer": ["operator"], "citizen-1": ["operator"], "citizen-2": ["operator"] });
    const policyId = await activePolicyId(store, checker);
    const attachment = await proposeAttachment(store, checker, defaultAuditEmitter, { policyId, principalRef: "citizen:abc", proposedBy: "citizen-1" }, NOW);

    const result = await endorseAttachment(store, checker, defaultAuditEmitter, attachment.id, { endorserCitizenId: "citizen-2", decision: "rejected" }, NOW);

    expect(result.attachment.status).toBe("pending_approval");
    expect(result.endorsement.decision).toBe("rejected");
  });

  // attachments.ts's own comment on this deviation states the consequence
  // explicitly: "a different citizen holding the same role_type can still
  // endorse it afterward" -- since the attachment never left
  // pending_approval, a rejected decision must not be treated as terminal
  // the way a rejected *policy* is. Previously unexercised.
  it("still allows a different citizen to activate the attachment after a prior rejected endorsement", async () => {
    const store = createStore();
    const checker = checkerFor({
      "policy-proposer": ["operator"],
      "citizen-1": ["operator"],
      "citizen-2": ["operator"],
      "citizen-3": ["operator"],
    });
    const policyId = await activePolicyId(store, checker);
    const attachment = await proposeAttachment(store, checker, defaultAuditEmitter, { policyId, principalRef: "citizen:abc", proposedBy: "citizen-1" }, NOW);
    await endorseAttachment(store, checker, defaultAuditEmitter, attachment.id, { endorserCitizenId: "citizen-2", decision: "rejected" }, NOW);

    const result = await endorseAttachment(store, checker, defaultAuditEmitter, attachment.id, { endorserCitizenId: "citizen-3", decision: "approved" }, NOW);

    expect(result.attachment.status).toBe("active");
  });

  it("rejects endorsing a nonexistent attachment with a 404", async () => {
    const store = createStore();
    const checker = checkerFor({ "citizen-2": ["operator"] });

    await expect(
      endorseAttachment(store, checker, defaultAuditEmitter, "missing-attachment", { endorserCitizenId: "citizen-2", decision: "approved" }, NOW),
    ).rejects.toThrow(/no policy_attachment/);
  });
});

describe("revokeAttachment", () => {
  it("does not require dual control -- a single platform_operator may revoke unilaterally", async () => {
    const store = createStore();
    const checker = checkerFor({ "policy-proposer": ["operator"], "citizen-1": ["operator"], "citizen-2": ["operator"] });
    const policyId = await activePolicyId(store, checker);
    const attachment = await proposeAttachment(store, checker, defaultAuditEmitter, { policyId, principalRef: "citizen:abc", proposedBy: "citizen-1" }, NOW);
    await endorseAttachment(store, checker, defaultAuditEmitter, attachment.id, { endorserCitizenId: "citizen-2", decision: "approved" }, NOW);

    const revokerChecker = checkerFor({ "citizen-9": ["platform_operator"] });
    const revoked = await revokeAttachment(store, revokerChecker, defaultAuditEmitter, attachment.id, { revokedBy: "citizen-9" }, NOW);

    expect(revoked.status).toBe("revoked");
  });

  it("rejects a revoker holding none of operator/platform_operator/auditor", async () => {
    const store = createStore();
    const checker = checkerFor({ "policy-proposer": ["operator"], "citizen-1": ["operator"] });
    const policyId = await activePolicyId(store, checker);
    const attachment = await proposeAttachment(store, checker, defaultAuditEmitter, { policyId, principalRef: "citizen:abc", proposedBy: "citizen-1" }, NOW);

    const revokerChecker = checkerFor({ "citizen-9": ["oversight"] });
    await expect(
      revokeAttachment(store, revokerChecker, defaultAuditEmitter, attachment.id, { revokedBy: "citizen-9" }, NOW),
    ).rejects.toThrow(/operator, platform_operator, or auditor/);
  });

  it("rejects revoking a nonexistent attachment with a 404", async () => {
    const store = createStore();
    const revokerChecker = checkerFor({ "citizen-9": ["auditor"] });

    await expect(
      revokeAttachment(store, revokerChecker, defaultAuditEmitter, "missing-attachment", { revokedBy: "citizen-9" }, NOW),
    ).rejects.toThrow(/no policy_attachment/);
  });

  // Same DP-072 "active or pending_approval only" gap as revokePolicy's
  // equivalent test -- previously unexercised for attachments.
  it("rejects revoking an already-revoked attachment", async () => {
    const store = createStore();
    const checker = checkerFor({ "policy-proposer": ["operator"], "citizen-1": ["operator"], "citizen-9": ["auditor"] });
    const policyId = await activePolicyId(store, checker);
    const attachment = await proposeAttachment(store, checker, defaultAuditEmitter, { policyId, principalRef: "citizen:abc", proposedBy: "citizen-1" }, NOW);
    await revokeAttachment(store, checker, defaultAuditEmitter, attachment.id, { revokedBy: "citizen-9" }, NOW);

    await expect(
      revokeAttachment(store, checker, defaultAuditEmitter, attachment.id, { revokedBy: "citizen-9" }, NOW),
    ).rejects.toThrow(/cannot revoke policy_attachment/);
  });
});
