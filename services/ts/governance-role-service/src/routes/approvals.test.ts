import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";
import type { Store } from "../store.js";
import type { ProtocolChangeExecutor, ProtocolGateChecker } from "../collaborators.js";

async function createActiveRole(
  app: ReturnType<typeof buildServer>,
  citizenId: string,
  layer: "citizen" | "audit" | "protocol" | "implementation" = "citizen",
) {
  const roleTypeByLayer = {
    citizen: "reviewer",
    audit: "auditor",
    protocol: "review_body",
    implementation: "operator",
  } as const;
  const res = await app.inject({
    method: "POST",
    url: "/governance-roles/roles",
    payload: {
      citizen_id: citizenId,
      role_type: roleTypeByLayer[layer],
      layer,
      randomized: false,
      term_start: "2026-01-01T00:00:00.000Z",
      term_end: "2026-12-01T00:00:00.000Z",
    },
  });
  return res.json().id as string;
}

describe("governance approvals routes", () => {
  let store: Store;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    store = createStore();
    app = buildServer({ store });
  });

  afterAll(async () => {
    await app.close();
  });

  it("POST /governance-roles/approvals records an approval", async () => {
    const roleId = await createActiveRole(app, "citizen-1");

    const res = await app.inject({
      method: "POST",
      url: "/governance-roles/approvals",
      payload: {
        action_ref: "action-1",
        approver_role_id: roleId,
        approval_type: "citizen_supermajority",
        decision: "approved",
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().decision).toBe("approved");
  });

  it("rejects a second approval from the same citizen on the same action_ref with 409", async () => {
    const roleId = await createActiveRole(app, "citizen-1");
    await app.inject({
      method: "POST",
      url: "/governance-roles/approvals",
      payload: {
        action_ref: "action-1",
        approver_role_id: roleId,
        approval_type: "citizen_supermajority",
        decision: "approved",
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/governance-roles/approvals",
      payload: {
        action_ref: "action-1",
        approver_role_id: roleId,
        approval_type: "audit_confirmation",
        decision: "approved",
      },
    });

    expect(res.statusCode).toBe(409);
  });

  it("rejects a COI-conflicted citizen's approval with 403", async () => {
    const conflictedStore = createStore();
    const conflictedApp = buildServer({
      store: conflictedStore,
      coiChecker: { hasConflict: () => true },
    });
    const roleId = await createActiveRole(conflictedApp, "citizen-1");

    const res = await conflictedApp.inject({
      method: "POST",
      url: "/governance-roles/approvals",
      payload: {
        action_ref: "action-1",
        approver_role_id: roleId,
        approval_type: "citizen_supermajority",
        decision: "approved",
      },
    });

    expect(res.statusCode).toBe(403);
    await conflictedApp.close();
  });

  it("GET /governance-roles/actions/:actionRef/status reports partial then full approval", async () => {
    const roleA = await createActiveRole(app, "citizen-1", "citizen");
    const roleB = await createActiveRole(app, "citizen-2", "audit");
    const roleC = await createActiveRole(app, "citizen-3", "protocol");

    await app.inject({
      method: "POST",
      url: "/governance-roles/approvals",
      payload: { action_ref: "action-1", approver_role_id: roleA, approval_type: "citizen_supermajority", decision: "approved" },
    });

    const partial = await app.inject({ method: "GET", url: "/governance-roles/actions/action-1/status" });
    expect(partial.statusCode).toBe(200);
    expect(partial.json().fully_approved).toBe(false);

    await app.inject({
      method: "POST",
      url: "/governance-roles/approvals",
      payload: { action_ref: "action-1", approver_role_id: roleB, approval_type: "audit_confirmation", decision: "approved" },
    });
    await app.inject({
      method: "POST",
      url: "/governance-roles/approvals",
      payload: { action_ref: "action-1", approver_role_id: roleC, approval_type: "body_endorsement", decision: "approved" },
    });

    const full = await app.inject({ method: "GET", url: "/governance-roles/actions/action-1/status" });
    expect(full.json().fully_approved).toBe(true);
  });

  it("POST /governance-roles/actions/:actionRef/execute succeeds once fully approved and is idempotent", async () => {
    const executor: ProtocolChangeExecutor = { execute: () => undefined };
    let executeCalls = 0;
    const countingExecutor: ProtocolChangeExecutor = {
      execute: (ref) => {
        executeCalls += 1;
        executor.execute(ref);
      },
    };
    const gate: ProtocolGateChecker = { isConfirmed: () => true };
    const localStore = createStore();
    const localApp = buildServer({
      store: localStore,
      protocolChangeExecutor: countingExecutor,
      protocolGateChecker: gate,
    });

    const roleA = await createActiveRole(localApp, "citizen-1", "citizen");
    const roleB = await createActiveRole(localApp, "citizen-2", "audit");
    const roleC = await createActiveRole(localApp, "citizen-3", "protocol");
    for (const [roleId, approvalType] of [
      [roleA, "citizen_supermajority"],
      [roleB, "audit_confirmation"],
      [roleC, "body_endorsement"],
    ] as const) {
      await localApp.inject({
        method: "POST",
        url: "/governance-roles/approvals",
        payload: { action_ref: "action-1", approver_role_id: roleId, approval_type: approvalType, decision: "approved" },
      });
    }

    const incomplete = await localApp.inject({
      method: "POST",
      url: "/governance-roles/actions/action-1/execute",
      payload: { delay_elapsed: false, publicly_visible: true },
    });
    expect(incomplete.statusCode).toBe(409);

    const first = await localApp.inject({
      method: "POST",
      url: "/governance-roles/actions/action-1/execute",
      payload: { delay_elapsed: true, publicly_visible: true },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().already_executed).toBe(false);

    const second = await localApp.inject({
      method: "POST",
      url: "/governance-roles/actions/action-1/execute",
      payload: { delay_elapsed: true, publicly_visible: true },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().already_executed).toBe(true);
    expect(executeCalls).toBe(1);

    await localApp.close();
  });
});
