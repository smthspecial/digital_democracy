import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";
import type { Store } from "../store.js";
import type { GovernanceRoleChecker } from "../collaborators.js";
import type { RoleType } from "../domain/types.js";

// A fake GovernanceRoleChecker backed by a plain citizenId -> roleTypes map,
// standing in for a live governance-role-service lookup -- same shape as
// services/policies.test.ts's own checkerFor.
function checkerFor(grants: Record<string, RoleType[]>): GovernanceRoleChecker {
  return {
    hasActiveRole: (citizenId, roleType) => (grants[citizenId] ?? []).includes(roleType),
  };
}

const BASE_POLICY_BODY = {
  name: "rotate-secrets",
  effect: "allow",
  actions: ["secrets:rotate"],
  resources: ["secrets:*"],
  description: "allow rotating secrets",
};

function buildApp(checker: GovernanceRoleChecker) {
  const store: Store = createStore();
  return { app: buildServer({ store, governanceRoleChecker: checker }), store };
}

describe("policies routes", () => {
  const { app } = buildApp(checkerFor({ "citizen-1": ["operator"], "citizen-2": ["operator"] }));

  afterAll(async () => {
    await app.close();
  });

  it("POST /iam/policies proposes a policy for a proposer holding an active operator role", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/iam/policies",
      payload: { ...BASE_POLICY_BODY, proposed_by: "citizen-1" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe("pending_approval");
    expect(body.proposed_by).toBe("citizen-1");
    expect(body.proposer_role_type).toBe("operator");
  });

  it("POST /iam/policies rejects a proposer holding neither operator nor platform_operator with 403", async () => {
    const { app: unprivilegedApp } = buildApp(checkerFor({ "citizen-9": ["auditor"] }));

    const res = await unprivilegedApp.inject({
      method: "POST",
      url: "/iam/policies",
      payload: { ...BASE_POLICY_BODY, proposed_by: "citizen-9" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toHaveProperty("error");
    await unprivilegedApp.close();
  });

  it("POST /iam/policies rejects a malformed body with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/iam/policies",
      payload: { ...BASE_POLICY_BODY, effect: "not-a-real-effect", proposed_by: "citizen-1" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("POST /iam/policies rejects a body missing a required field with 400", async () => {
    const { name: _name, ...bodyWithoutName } = BASE_POLICY_BODY;
    const res = await app.inject({
      method: "POST",
      url: "/iam/policies",
      payload: { ...bodyWithoutName, proposed_by: "citizen-1" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("propose -> endorse -> activate round trip, then GET reflects the active policy", async () => {
    const propose = await app.inject({
      method: "POST",
      url: "/iam/policies",
      payload: { ...BASE_POLICY_BODY, proposed_by: "citizen-1" },
    });
    const policyId = propose.json().id as string;

    const endorse = await app.inject({
      method: "POST",
      url: `/iam/policies/${policyId}/endorsements`,
      payload: { endorser_citizen_id: "citizen-2", decision: "approved" },
    });
    expect(endorse.statusCode).toBe(201);
    expect(endorse.json().policy.status).toBe("active");
    expect(endorse.json().endorsement.decision).toBe("approved");

    const list = await app.inject({ method: "GET", url: "/iam/policies?status=active" });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((policy: { id: string }) => policy.id === policyId)).toBe(true);
  });

  it("POST /iam/policies/:id/endorsements rejects an endorser holding a different role_type than the proposer with 403", async () => {
    const { app: mixedApp } = buildApp(
      checkerFor({ "citizen-1": ["operator"], "citizen-2": ["platform_operator"] }),
    );
    const propose = await mixedApp.inject({
      method: "POST",
      url: "/iam/policies",
      payload: { ...BASE_POLICY_BODY, proposed_by: "citizen-1" },
    });
    const policyId = propose.json().id as string;

    const res = await mixedApp.inject({
      method: "POST",
      url: `/iam/policies/${policyId}/endorsements`,
      payload: { endorser_citizen_id: "citizen-2", decision: "approved" },
    });

    expect(res.statusCode).toBe(403);
    await mixedApp.close();
  });

  it("POST /iam/policies/:id/revoke revokes unilaterally, no dual control required", async () => {
    const propose = await app.inject({
      method: "POST",
      url: "/iam/policies",
      payload: { ...BASE_POLICY_BODY, proposed_by: "citizen-1" },
    });
    const policyId = propose.json().id as string;

    // citizen-2 revokes unilaterally -- no endorsement/dual-control step,
    // unlike the propose -> endorse -> activate round trip above.
    const revoke = await app.inject({
      method: "POST",
      url: `/iam/policies/${policyId}/revoke`,
      payload: { revoked_by: "citizen-2" },
    });

    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().status).toBe("revoked");
  });

  it("POST /iam/policies/:id/revoke rejects revoking an already-revoked policy with 409", async () => {
    const propose = await app.inject({
      method: "POST",
      url: "/iam/policies",
      payload: { ...BASE_POLICY_BODY, proposed_by: "citizen-1" },
    });
    const policyId = propose.json().id as string;
    await app.inject({
      method: "POST",
      url: `/iam/policies/${policyId}/revoke`,
      payload: { revoked_by: "citizen-2" },
    });

    const secondRevoke = await app.inject({
      method: "POST",
      url: `/iam/policies/${policyId}/revoke`,
      payload: { revoked_by: "citizen-2" },
    });

    expect(secondRevoke.statusCode).toBe(409);
    expect(secondRevoke.json()).toHaveProperty("error");
  });
});
