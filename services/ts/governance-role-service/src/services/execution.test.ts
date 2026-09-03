import { describe, expect, it, vi } from "vitest";
import { createStore } from "../store.js";
import { defaultAuditEmitter, defaultCOIChecker } from "../collaborators.js";
import type { ProtocolChangeExecutor, ProtocolGateChecker } from "../collaborators.js";
import { createRole } from "./roles.js";
import { submitApproval } from "./approvals.js";
import { executeAction } from "./execution.js";
import type { Store } from "../store.js";

const NOW = new Date("2026-03-01T00:00:00Z");

async function fullyApprovedAction(store: Store, actionRef: string): Promise<void> {
  const types = ["citizen_supermajority", "audit_confirmation", "body_endorsement"] as const;
  const layerByType = {
    citizen_supermajority: "citizen",
    audit_confirmation: "audit",
    body_endorsement: "protocol",
  } as const;
  const roleTypeByLayer = {
    citizen: "reviewer",
    audit: "auditor",
    protocol: "review_body",
  } as const;
  for (const [i, approvalType] of types.entries()) {
    const layer = layerByType[approvalType];
    const role = createRole(store, defaultAuditEmitter, {
      citizenId: `citizen-${i}`,
      roleType: roleTypeByLayer[layer],
      layer,
      randomized: false,
      termStart: new Date("2026-01-01T00:00:00Z"),
      termEnd: new Date("2026-12-01T00:00:00Z"),
    });
    await submitApproval(
      store,
      defaultCOIChecker,
      defaultAuditEmitter,
      { actionRef, approverRoleId: role.id, approvalType, decision: "approved" },
      NOW,
    );
  }
}

function confirmedGate(): ProtocolGateChecker {
  return { isConfirmed: () => true };
}

describe("executeAction", () => {
  it("rejects when approvals are incomplete", () => {
    const store = createStore();
    const executor: ProtocolChangeExecutor = { execute: vi.fn() };

    expect(() =>
      executeAction(
        store,
        confirmedGate(),
        executor,
        defaultAuditEmitter,
        "action-1",
        { delayElapsed: true, publiclyVisible: true },
        NOW,
      ),
    ).toThrow(/approval/);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("rejects when delay has not elapsed", async () => {
    const store = createStore();
    await fullyApprovedAction(store, "action-1");
    const executor: ProtocolChangeExecutor = { execute: vi.fn() };

    expect(() =>
      executeAction(
        store,
        confirmedGate(),
        executor,
        defaultAuditEmitter,
        "action-1",
        { delayElapsed: false, publiclyVisible: true },
        NOW,
      ),
    ).toThrow(/delay/);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("rejects when the change was not publicly visible", async () => {
    const store = createStore();
    await fullyApprovedAction(store, "action-1");
    const executor: ProtocolChangeExecutor = { execute: vi.fn() };

    expect(() =>
      executeAction(
        store,
        confirmedGate(),
        executor,
        defaultAuditEmitter,
        "action-1",
        { delayElapsed: true, publiclyVisible: false },
        NOW,
      ),
    ).toThrow(/public/);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("rejects when the protocol gate is not confirmed", async () => {
    const store = createStore();
    await fullyApprovedAction(store, "action-1");
    const executor: ProtocolChangeExecutor = { execute: vi.fn() };
    const unconfirmedGate: ProtocolGateChecker = { isConfirmed: () => false };

    expect(() =>
      executeAction(
        store,
        unconfirmedGate,
        executor,
        defaultAuditEmitter,
        "action-1",
        { delayElapsed: true, publiclyVisible: true },
        NOW,
      ),
    ).toThrow(/gate/);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("succeeds and calls the executor exactly once when every precondition is met", async () => {
    const store = createStore();
    await fullyApprovedAction(store, "action-1");
    const executor: ProtocolChangeExecutor = { execute: vi.fn() };

    const result = executeAction(
      store,
      confirmedGate(),
      executor,
      defaultAuditEmitter,
      "action-1",
      { delayElapsed: true, publiclyVisible: true },
      NOW,
    );

    expect(result.executed).toBe(true);
    expect(result.alreadyExecuted).toBe(false);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledWith("action-1");
  });

  it("is idempotent: a second execute call returns the same result without re-invoking the gate or executor", async () => {
    const store = createStore();
    await fullyApprovedAction(store, "action-1");
    const executor: ProtocolChangeExecutor = { execute: vi.fn() };
    const gate: ProtocolGateChecker = { isConfirmed: vi.fn(() => true) };

    const first = executeAction(
      store,
      gate,
      executor,
      defaultAuditEmitter,
      "action-1",
      { delayElapsed: true, publiclyVisible: true },
      NOW,
    );
    const second = executeAction(
      store,
      gate,
      executor,
      defaultAuditEmitter,
      "action-1",
      { delayElapsed: true, publiclyVisible: true },
      NOW,
    );

    expect(second.executed).toBe(true);
    expect(second.alreadyExecuted).toBe(true);
    expect(second.executedAt).toEqual(first.executedAt);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(gate.isConfirmed).toHaveBeenCalledTimes(1);
  });
});
