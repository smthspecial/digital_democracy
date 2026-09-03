import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";
import type { Store } from "../store.js";
import type { GovernanceRoleChecker } from "../collaborators.js";
import type { RoleType } from "../domain/types.js";

function checkerFor(grants: Record<string, RoleType[]>): GovernanceRoleChecker {
  return {
    hasActiveRole: (citizenId, roleType) => (grants[citizenId] ?? []).includes(roleType),
  };
}

// Seeds an active access_policy + active attachment directly against the
// store, bypassing propose/endorse entirely -- mirrors
// services/evaluate.test.ts's own seedActivePolicy/seedActiveAttachment;
// this route test only needs to confirm POST /iam/evaluate wires the
// request/response correctly, not re-verify the matching algorithm itself.
function seedActivePolicyAndAttachment(store: Store, principalRef: string): string {
  const policy = store.createPolicy({
    name: "test-policy",
    effect: "allow",
    actions: ["secrets:rotate"],
    resources: ["secrets:*"],
    conditions: null,
    description: "test",
    proposedBy: "proposer-1",
    proposerRoleType: "operator",
  });
  store.setPolicyStatus(policy.id, "active");
  const attachment = store.createAttachment({
    policyId: policy.id,
    principalRef,
    proposedBy: "proposer-1",
    proposerRoleType: "operator",
  });
  store.setAttachmentStatus(attachment.id, "active");
  return policy.id;
}

describe("evaluate route", () => {
  const store = createStore();
  const app = buildServer({ store, governanceRoleChecker: checkerFor({}) });

  afterAll(async () => {
    await app.close();
  });

  it("POST /iam/evaluate allows an action matching an attached, active allow policy", async () => {
    const policyId = seedActivePolicyAndAttachment(store, "citizen:abc");

    const res = await app.inject({
      method: "POST",
      url: "/iam/evaluate",
      payload: { principal_ref: "citizen:abc", action: "secrets:rotate", resource: "secrets:db-password" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ effect: "allow", matched_policy_id: policyId });
  });

  it("POST /iam/evaluate denies by default when no attachment matches the principal", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/iam/evaluate",
      payload: { principal_ref: "citizen:nobody", action: "secrets:rotate", resource: "secrets:db-password" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ effect: "deny", matched_policy_id: null });
  });

  it("POST /iam/evaluate rejects a malformed body with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/iam/evaluate",
      payload: { principal_ref: "citizen:abc", action: "secrets:rotate" }, // missing resource
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });
});
