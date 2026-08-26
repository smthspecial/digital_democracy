import { describe, expect, it } from "vitest";
import { createStore } from "../store.js";
import { defaultAuditEmitter, defaultCOIChecker } from "../collaborators.js";
import type { COIChecker } from "../collaborators.js";
import { createRole } from "./roles.js";
import { getActionStatus, submitApproval } from "./approvals.js";
import type { Store } from "../store.js";
import type { GovernanceRole } from "../domain/types.js";

const NOW = new Date("2026-03-01T00:00:00Z");

function activeRole(store: Store, citizenId: string): GovernanceRole {
  return createRole(store, defaultAuditEmitter, {
    citizenId,
    roleType: "reviewer",
    layer: "citizen",
    randomized: false,
    termStart: new Date("2026-01-01T00:00:00Z"),
    termEnd: new Date("2026-12-01T00:00:00Z"),
  });
}

describe("submitApproval", () => {
  it("records an approval for an active role", () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1");

    const approval = submitApproval(
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

  it("rejects when the approver role does not exist", () => {
    const store = createStore();
    expect(() =>
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
    ).toThrow(/does not reference an existing governance role/);
  });

  it("rejects when the approver role is not currently active", () => {
    const store = createStore();
    const role = createRole(store, defaultAuditEmitter, {
      citizenId: "citizen-1",
      roleType: "reviewer",
      layer: "citizen",
      randomized: false,
      termStart: new Date("2025-01-01T00:00:00Z"),
      termEnd: new Date("2025-06-01T00:00:00Z"),
    });

    expect(() =>
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
    ).toThrow(/active/);
  });

  it("rejects a citizen with a conflict of interest", () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1");
    const conflicted: COIChecker = { hasConflict: () => true };

    expect(() =>
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
    ).toThrow(/conflict/);
  });

  it("rejects a second approval from the same citizen on the same action_ref, even under a different approval_type", () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1");

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
    );

    expect(() =>
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
    ).toThrow(/already submitted/);
  });

  it("allows the same citizen to approve two different action_refs", () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1");

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
    );

    expect(() =>
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
    ).not.toThrow();
  });
});

describe("getActionStatus", () => {
  it("reports partial approval when only some types are satisfied", () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1");
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
    );

    const status = getActionStatus(store, "action-1");
    expect(status.fullyApproved).toBe(false);
    expect(status.satisfiedTypes).toEqual(["citizen_supermajority"]);
  });

  it("reports full approval once all three types are satisfied by independent role holders", () => {
    const store = createStore();
    const roleA = activeRole(store, "citizen-1");
    const roleB = activeRole(store, "citizen-2");
    const roleC = activeRole(store, "citizen-3");

    submitApproval(
      store,
      defaultCOIChecker,
      defaultAuditEmitter,
      { actionRef: "action-1", approverRoleId: roleA.id, approvalType: "citizen_supermajority", decision: "approved" },
      NOW,
    );
    submitApproval(
      store,
      defaultCOIChecker,
      defaultAuditEmitter,
      { actionRef: "action-1", approverRoleId: roleB.id, approvalType: "audit_confirmation", decision: "approved" },
      NOW,
    );
    submitApproval(
      store,
      defaultCOIChecker,
      defaultAuditEmitter,
      { actionRef: "action-1", approverRoleId: roleC.id, approvalType: "body_endorsement", decision: "approved" },
      NOW,
    );

    const status = getActionStatus(store, "action-1");
    expect(status.fullyApproved).toBe(true);
    expect(status.satisfiedTypes.sort()).toEqual(
      ["audit_confirmation", "body_endorsement", "citizen_supermajority"].sort(),
    );
  });

  it("does not count a rejected decision as satisfying its type", () => {
    const store = createStore();
    const role = activeRole(store, "citizen-1");
    submitApproval(
      store,
      defaultCOIChecker,
      defaultAuditEmitter,
      { actionRef: "action-1", approverRoleId: role.id, approvalType: "citizen_supermajority", decision: "rejected" },
      NOW,
    );

    const status = getActionStatus(store, "action-1");
    expect(status.satisfiedTypes).toEqual([]);
    expect(status.fullyApproved).toBe(false);
  });
});
