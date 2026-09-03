import { describe, expect, it } from "vitest";
import { createStore } from "../store.js";
import type { GovernanceRoleChecker } from "../collaborators.js";
import type { RoleType } from "../domain/types.js";
import { evaluateAccess } from "./evaluate.js";

function checkerFor(grants: Record<string, RoleType[]>): GovernanceRoleChecker {
  return {
    hasActiveRole: (citizenId, roleType) => (grants[citizenId] ?? []).includes(roleType),
  };
}

// Seeds an active access_policy directly against the store, bypassing the
// propose/endorse flow entirely -- evaluate.ts only ever reads status
// 'active' rows, and its own tests don't need to re-exercise dual control
// (that's policies.test.ts's job).
function seedActivePolicy(
  store: ReturnType<typeof createStore>,
  overrides: Partial<{
    effect: "allow" | "deny";
    actions: string[];
    resources: string[];
    conditions: Record<string, unknown> | null;
  }>,
): string {
  const policy = store.createPolicy({
    name: "test-policy",
    effect: overrides.effect ?? "allow",
    actions: overrides.actions ?? ["secrets:rotate"],
    resources: overrides.resources ?? ["secrets:*"],
    conditions: overrides.conditions ?? null,
    description: "test",
    proposedBy: "proposer-1",
    proposerRoleType: "operator",
  });
  store.setPolicyStatus(policy.id, "active");
  return policy.id;
}

function seedActiveAttachment(store: ReturnType<typeof createStore>, policyId: string, principalRef: string): void {
  const attachment = store.createAttachment({
    policyId,
    principalRef,
    proposedBy: "proposer-1",
    proposerRoleType: "operator",
  });
  store.setAttachmentStatus(attachment.id, "active");
}

describe("evaluateAccess", () => {
  it("allows an action matching an attached, active allow policy", async () => {
    const store = createStore();
    const policyId = seedActivePolicy(store, {});
    seedActiveAttachment(store, policyId, "citizen:abc");

    const result = await evaluateAccess(store, checkerFor({}), {
      principalRef: "citizen:abc",
      action: "secrets:rotate",
      resource: "secrets:db-password",
    });

    expect(result).toEqual({ effect: "allow", matchedPolicyId: policyId });
  });

  it("matches wildcard actions and resources by prefix", async () => {
    const store = createStore();
    const policyId = seedActivePolicy(store, { actions: ["secrets:*"], resources: ["secrets:*"] });
    seedActiveAttachment(store, policyId, "citizen:abc");

    const result = await evaluateAccess(store, checkerFor({}), {
      principalRef: "citizen:abc",
      action: "secrets:rotate",
      resource: "secrets:db-password",
    });

    expect(result.effect).toBe("allow");
    expect(result.matchedPolicyId).toBe(policyId);
  });

  it("denies by default when no attached policy matches the action/resource", async () => {
    const store = createStore();
    const policyId = seedActivePolicy(store, { actions: ["budget:approve"] });
    seedActiveAttachment(store, policyId, "citizen:abc");

    const result = await evaluateAccess(store, checkerFor({}), {
      principalRef: "citizen:abc",
      action: "secrets:rotate",
      resource: "secrets:db-password",
    });

    expect(result).toEqual({ effect: "deny", matchedPolicyId: null });
  });

  it("denies by default when the principal has no attachments at all", async () => {
    const store = createStore();
    const result = await evaluateAccess(store, checkerFor({}), {
      principalRef: "citizen:nobody",
      action: "secrets:rotate",
      resource: "secrets:db-password",
    });

    expect(result).toEqual({ effect: "deny", matchedPolicyId: null });
  });

  it("lets an explicit deny policy override a matching allow policy", async () => {
    const store = createStore();
    const allowId = seedActivePolicy(store, { effect: "allow", actions: ["secrets:*"], resources: ["secrets:*"] });
    const denyId = seedActivePolicy(store, { effect: "deny", actions: ["secrets:rotate"], resources: ["secrets:*"] });
    seedActiveAttachment(store, allowId, "citizen:abc");
    seedActiveAttachment(store, denyId, "citizen:abc");

    const result = await evaluateAccess(store, checkerFor({}), {
      principalRef: "citizen:abc",
      action: "secrets:rotate",
      resource: "secrets:db-password",
    });

    expect(result).toEqual({ effect: "deny", matchedPolicyId: denyId });
  });

  it("expands a role:<roleType> attachment to every citizen currently holding that active role", async () => {
    const store = createStore();
    const policyId = seedActivePolicy(store, {});
    seedActiveAttachment(store, policyId, "role:platform_operator");
    const checker = checkerFor({ "citizen-abc": ["platform_operator"] });

    const result = await evaluateAccess(store, checker, {
      principalRef: "citizen:citizen-abc",
      action: "secrets:rotate",
      resource: "secrets:db-password",
    });

    expect(result).toEqual({ effect: "allow", matchedPolicyId: policyId });
  });

  it("does not apply a role:<roleType> attachment to a citizen who no longer holds that active role", async () => {
    const store = createStore();
    const policyId = seedActivePolicy(store, {});
    seedActiveAttachment(store, policyId, "role:platform_operator");
    const checker = checkerFor({ "citizen-abc": [] });

    const result = await evaluateAccess(store, checker, {
      principalRef: "citizen:citizen-abc",
      action: "secrets:rotate",
      resource: "secrets:db-password",
    });

    expect(result).toEqual({ effect: "deny", matchedPolicyId: null });
  });

  it("requires every condition key to match the request's context", async () => {
    const store = createStore();
    const policyId = seedActivePolicy(store, { conditions: { environment: "production" } });
    seedActiveAttachment(store, policyId, "citizen:abc");

    const matching = await evaluateAccess(store, checkerFor({}), {
      principalRef: "citizen:abc",
      action: "secrets:rotate",
      resource: "secrets:db-password",
      context: { environment: "production" },
    });
    expect(matching.effect).toBe("allow");

    const nonMatching = await evaluateAccess(store, checkerFor({}), {
      principalRef: "citizen:abc",
      action: "secrets:rotate",
      resource: "secrets:db-password",
      context: { environment: "staging" },
    });
    expect(nonMatching).toEqual({ effect: "deny", matchedPolicyId: null });
  });

  it("ignores an inactive (pending_approval or revoked) attachment or policy", async () => {
    const store = createStore();
    const policy = store.createPolicy({
      name: "not-yet-active",
      effect: "allow",
      actions: ["secrets:rotate"],
      resources: ["secrets:*"],
      conditions: null,
      description: "test",
      proposedBy: "proposer-1",
      proposerRoleType: "operator",
    });
    // Left at status 'pending_approval' -- never activated.
    store.createAttachment({
      policyId: policy.id,
      principalRef: "citizen:abc",
      proposedBy: "proposer-1",
      proposerRoleType: "operator",
    }); // Also left 'pending_approval'.

    const result = await evaluateAccess(store, checkerFor({}), {
      principalRef: "citizen:abc",
      action: "secrets:rotate",
      resource: "secrets:db-password",
    });

    expect(result).toEqual({ effect: "deny", matchedPolicyId: null });
  });
});
