import { describe, expect, it } from "vitest";
import { createStore } from "../store.js";
import { defaultAuditEmitter, defaultCOIChecker } from "../collaborators.js";
import type { COIChecker } from "../collaborators.js";
import { createRole } from "./roles.js";
import { getActionStatus, submitApproval } from "./approvals.js";
import type { Store } from "../store.js";
import type { GovernanceRole } from "../domain/types.js";

const NOW = new Date("2026-03-01T00:00:00Z");

function activeRole(
  store: Store,
  citizenId: string,
  layer: "citizen" | "audit" | "protocol" | "implementation" = "citizen",
): GovernanceRole {
  const roleTypeByLayer = {
    citizen: "reviewer",
    audit: "auditor",
    protocol: "review_body",
    implementation: "operator",
  } as const;
  return createRole(store, defaultAuditEmitter, {
    citizenId,
    roleType: roleTypeByLayer[layer],
    layer,
    randomized: false,
    termStart: new Date("2026-01-01T00:00:00Z"),
    termEnd: new Date("2026-12-01T00:00:00Z"),
  });
}

describe("submitApproval", () => {
  it("records an approval for an active role", async () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1");

    const approval = await submitApproval(
      store,
      defaultCOIChecker,
      defaultAuditEmitter,
      {
        actionRef: "action-1",
        approverRoleId: role.id,
        approvalType: "citizen_supermajority",
        decision: "approved",
      },
      NOW,
    );

    expect(approval.actionRef).toBe("action-1");
    expect(approval.decision).toBe("approved");
  });

  it("rejects when the approver role does not exist", async () => {
    const store = createStore();
    await expect(
      submitApproval(
        store,
        defaultCOIChecker,
        defaultAuditEmitter,
        {
          actionRef: "action-1",
          approverRoleId: "missing-role",
          approvalType: "citizen_supermajority",
          decision: "approved",
        },
        NOW,
      ),
    ).rejects.toThrow(/does not reference an existing governance role/);
  });

  it("rejects when the approver role is not currently active", async () => {
    const store = createStore();
    const role = createRole(store, defaultAuditEmitter, {
      citizenId: "citizen-1",
      roleType: "reviewer",
      layer: "citizen",
      randomized: false,
      termStart: new Date("2025-01-01T00:00:00Z"),
      termEnd: new Date("2025-06-01T00:00:00Z"),
    });

    await expect(
      submitApproval(
        store,
        defaultCOIChecker,
        defaultAuditEmitter,
        {
          actionRef: "action-1",
          approverRoleId: role.id,
          approvalType: "citizen_supermajority",
          decision: "approved",
        },
        NOW,
      ),
    ).rejects.toThrow(/active/);
  });

  it("rejects a citizen with a conflict of interest", async () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1");
    const conflicted: COIChecker = { hasConflict: () => true };

    await expect(
      submitApproval(
        store,
        conflicted,
        defaultAuditEmitter,
        {
          actionRef: "action-1",
          approverRoleId: role.id,
          approvalType: "citizen_supermajority",
          decision: "approved",
        },
        NOW,
      ),
    ).rejects.toThrow(/conflict/);
  });

  it("rejects a citizen with a conflict of interest reported by an async COIChecker", async () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1");
    const conflicted: COIChecker = { hasConflict: async () => true };

    await expect(
      submitApproval(
        store,
        conflicted,
        defaultAuditEmitter,
        {
          actionRef: "action-1",
          approverRoleId: role.id,
          approvalType: "citizen_supermajority",
          decision: "approved",
        },
        NOW,
      ),
    ).rejects.toThrow(/conflict/);
  });

  it("rejects a second approval from the same citizen on the same action_ref, even under a different approval_type", async () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1");

    await submitApproval(
      store,
      defaultCOIChecker,
      defaultAuditEmitter,
      {
        actionRef: "action-1",
        approverRoleId: role.id,
        approvalType: "citizen_supermajority",
        decision: "approved",
      },
      NOW,
    );

    await expect(
      submitApproval(
        store,
        defaultCOIChecker,
        defaultAuditEmitter,
        {
          actionRef: "action-1",
          approverRoleId: role.id,
          approvalType: "audit_confirmation",
          decision: "approved",
        },
        NOW,
      ),
    ).rejects.toThrow(/already submitted/);
  });

  it("rejects an audit_confirmation submitted by a role outside the audit layer", async () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1", "citizen");

    await expect(
      submitApproval(
        store,
        defaultCOIChecker,
        defaultAuditEmitter,
        {
          actionRef: "action-1",
          approverRoleId: role.id,
          approvalType: "audit_confirmation",
          decision: "approved",
        },
        NOW,
      ),
    ).rejects.toThrow(/audit layer/);
  });

  it("rejects a body_endorsement submitted by a role outside the protocol layer", async () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1", "audit");

    await expect(
      submitApproval(
        store,
        defaultCOIChecker,
        defaultAuditEmitter,
        {
          actionRef: "action-1",
          approverRoleId: role.id,
          approvalType: "body_endorsement",
          decision: "approved",
        },
        NOW,
      ),
    ).rejects.toThrow(/protocol layer/);
  });

  it("allows an audit_confirmation submitted by a role in the audit layer", async () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1", "audit");

    await expect(
      submitApproval(
        store,
        defaultCOIChecker,
        defaultAuditEmitter,
        {
          actionRef: "action-1",
          approverRoleId: role.id,
          approvalType: "audit_confirmation",
          decision: "approved",
        },
        NOW,
      ),
    ).resolves.not.toThrow();
  });

  it("allows the same citizen to approve two different action_refs", async () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1");

    await submitApproval(
      store,
      defaultCOIChecker,
      defaultAuditEmitter,
      {
        actionRef: "action-1",
        approverRoleId: role.id,
        approvalType: "citizen_supermajority",
        decision: "approved",
      },
      NOW,
    );

    await expect(
      submitApproval(
        store,
        defaultCOIChecker,
        defaultAuditEmitter,
        {
          actionRef: "action-2",
          approverRoleId: role.id,
          approvalType: "citizen_supermajority",
          decision: "approved",
        },
        NOW,
      ),
    ).resolves.not.toThrow();
  });
});

describe("getActionStatus", () => {
  it("reports partial approval when only some types are satisfied", async () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1");
    await submitApproval(
      store,
      defaultCOIChecker,
      defaultAuditEmitter,
      {
        actionRef: "action-1",
        approverRoleId: role.id,
        approvalType: "citizen_supermajority",
        decision: "approved",
      },
      NOW,
    );

    const status = getActionStatus(store, "action-1", NOW);
    expect(status.fullyApproved).toBe(false);
    expect(status.satisfiedTypes).toEqual(["citizen_supermajority"]);
  });

  it("reports full approval once all three types are satisfied by independent role holders", async () => {
    const store = createStore();
    const roleA = activeRole(store, "citizen-1", "citizen");
    const roleB = activeRole(store, "citizen-2", "audit");
    const roleC = activeRole(store, "citizen-3", "protocol");

    await submitApproval(
      store,
      defaultCOIChecker,
      defaultAuditEmitter,
      { actionRef: "action-1", approverRoleId: roleA.id, approvalType: "citizen_supermajority", decision: "approved" },
      NOW,
    );
    await submitApproval(
      store,
      defaultCOIChecker,
      defaultAuditEmitter,
      { actionRef: "action-1", approverRoleId: roleB.id, approvalType: "audit_confirmation", decision: "approved" },
      NOW,
    );
    await submitApproval(
      store,
      defaultCOIChecker,
      defaultAuditEmitter,
      { actionRef: "action-1", approverRoleId: roleC.id, approvalType: "body_endorsement", decision: "approved" },
      NOW,
    );

    const status = getActionStatus(store, "action-1", NOW);
    expect(status.fullyApproved).toBe(true);
    expect(status.satisfiedTypes.sort()).toEqual(
      ["audit_confirmation", "body_endorsement", "citizen_supermajority"].sort(),
    );
  });

  it("does not count a rejected decision as satisfying its type", async () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1");
    await submitApproval(
      store,
      defaultCOIChecker,
      defaultAuditEmitter,
      { actionRef: "action-1", approverRoleId: role.id, approvalType: "citizen_supermajority", decision: "rejected" },
      NOW,
    );

    const status = getActionStatus(store, "action-1", NOW);
    expect(status.satisfiedTypes).toEqual([]);
    expect(status.fullyApproved).toBe(false);
  });

  // ARCH-010 EC-9: an approval accepted while the approver role's term was
  // still current must stop counting once that term has since ended --
  // getActionStatus re-validates role activity at read time (`now`), not
  // only at submitApproval's write time.
  it("stops counting an approval once its approver role's term has since expired", async () => {
    const store = createStore();
    const role = createRole(store, defaultAuditEmitter, {
      citizenId: "citizen-1",
      roleType: "reviewer",
      layer: "citizen",
      randomized: false,
      termStart: new Date("2026-01-01T00:00:00Z"),
      termEnd: new Date("2026-02-01T00:00:00Z"),
    });
    const submittedAt = new Date("2026-01-15T00:00:00Z");
    await submitApproval(
      store,
      defaultCOIChecker,
      defaultAuditEmitter,
      { actionRef: "action-1", approverRoleId: role.id, approvalType: "citizen_supermajority", decision: "approved" },
      submittedAt,
    );

    const whileTermCurrent = getActionStatus(store, "action-1", submittedAt);
    expect(whileTermCurrent.satisfiedTypes).toEqual(["citizen_supermajority"]);

    const afterTermExpired = getActionStatus(store, "action-1", new Date("2026-03-01T00:00:00Z"));
    expect(afterTermExpired.satisfiedTypes).toEqual([]);
    expect(afterTermExpired.fullyApproved).toBe(false);
  });
});
