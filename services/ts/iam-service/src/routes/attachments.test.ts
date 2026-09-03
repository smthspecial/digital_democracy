import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";
import type { Store } from "../store.js";
import type { GovernanceRoleChecker } from "../collaborators.js";
import type { RoleType } from "../domain/types.js";

// Same fake-checker convention as policies.test.ts / services/attachments.test.ts.
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

async function proposedPolicyId(
  app: ReturnType<typeof buildServer>,
  proposedBy = "policy-proposer",
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/iam/policies",
    payload: { ...BASE_POLICY_BODY, proposed_by: proposedBy },
  });
  return res.json().id as string;
}

describe("attachments routes", () => {
  const { app } = buildApp(
    checkerFor({
      "policy-proposer": ["operator"],
      "citizen-1": ["operator"],
      "citizen-2": ["operator"],
    }),
  );

  afterAll(async () => {
    await app.close();
  });

  it("POST /iam/attachments proposes an attachment for a proposer holding an active operator role", async () => {
    const policyId = await proposedPolicyId(app);

    const res = await app.inject({
      method: "POST",
      url: "/iam/attachments",
      payload: { policy_id: policyId, principal_ref: "citizen:abc", proposed_by: "citizen-1" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.status).toBe("pending_approval");
    expect(body.policy_id).toBe(policyId);
    expect(body.proposer_role_type).toBe("operator");
  });

  it("POST /iam/attachments rejects a proposer holding neither operator nor platform_operator with 403", async () => {
    // proposeAttachment checks the policy exists before checking proposer
    // eligibility (attachments.ts), so the policy_id must resolve against
    // *this* app's own store -- an unrelated app/store's id would 404
    // instead, masking the 403 this test targets.
    const { app: unprivilegedApp } = buildApp(
      checkerFor({ "policy-proposer": ["operator"], "citizen-9": ["reviewer"] }),
    );
    const policyId = await proposedPolicyId(unprivilegedApp);

    const res = await unprivilegedApp.inject({
      method: "POST",
      url: "/iam/attachments",
      payload: { policy_id: policyId, principal_ref: "citizen:abc", proposed_by: "citizen-9" },
    });

    expect(res.statusCode).toBe(403);
    await unprivilegedApp.close();
  });

  it("POST /iam/attachments rejects a malformed body with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/iam/attachments",
      payload: { principal_ref: "citizen:abc", proposed_by: "citizen-1" }, // missing policy_id
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error");
  });

  it("propose -> endorse -> activate round trip, then GET filters by principal_ref", async () => {
    const policyId = await proposedPolicyId(app);

    const propose = await app.inject({
      method: "POST",
      url: "/iam/attachments",
      payload: { policy_id: policyId, principal_ref: "citizen:round-trip", proposed_by: "citizen-1" },
    });
    const attachmentId = propose.json().id as string;

    const endorse = await app.inject({
      method: "POST",
      url: `/iam/attachments/${attachmentId}/endorsements`,
      payload: { endorser_citizen_id: "citizen-2", decision: "approved" },
    });
    expect(endorse.statusCode).toBe(201);
    expect(endorse.json().attachment.status).toBe("active");

    const list = await app.inject({
      method: "GET",
      url: "/iam/attachments?principal_ref=citizen:round-trip",
    });
    expect(list.statusCode).toBe(200);
    const attachments = list.json();
    expect(attachments).toHaveLength(1);
    expect(attachments[0].id).toBe(attachmentId);
  });

  it("POST /iam/attachments/:id/endorsements rejects an endorser holding a different role_type than the proposer with 403", async () => {
    const { app: mixedApp } = buildApp(
      checkerFor({
        "policy-proposer": ["operator"],
        "citizen-1": ["operator"],
        "citizen-2": ["platform_operator"],
      }),
    );
    const policyId = await proposedPolicyId(mixedApp);
    const propose = await mixedApp.inject({
      method: "POST",
      url: "/iam/attachments",
      payload: { policy_id: policyId, principal_ref: "citizen:abc", proposed_by: "citizen-1" },
    });
    const attachmentId = propose.json().id as string;

    const res = await mixedApp.inject({
      method: "POST",
      url: `/iam/attachments/${attachmentId}/endorsements`,
      payload: { endorser_citizen_id: "citizen-2", decision: "approved" },
    });

    expect(res.statusCode).toBe(403);
    await mixedApp.close();
  });

  it("POST /iam/attachments/:id/revoke revokes unilaterally, no dual control required", async () => {
    const policyId = await proposedPolicyId(app);
    const propose = await app.inject({
      method: "POST",
      url: "/iam/attachments",
      payload: { policy_id: policyId, principal_ref: "citizen:revoke-me", proposed_by: "citizen-1" },
    });
    const attachmentId = propose.json().id as string;

    const revoke = await app.inject({
      method: "POST",
      url: `/iam/attachments/${attachmentId}/revoke`,
      payload: { revoked_by: "citizen-2" },
    });

    expect(revoke.statusCode).toBe(200);
    expect(revoke.json().status).toBe("revoked");
  });

  it("POST /iam/attachments/:id/revoke rejects revoking an already-revoked attachment with 409", async () => {
    const policyId = await proposedPolicyId(app);
    const propose = await app.inject({
      method: "POST",
      url: "/iam/attachments",
      payload: { policy_id: policyId, principal_ref: "citizen:revoke-twice", proposed_by: "citizen-1" },
    });
    const attachmentId = propose.json().id as string;
    await app.inject({
      method: "POST",
      url: `/iam/attachments/${attachmentId}/revoke`,
      payload: { revoked_by: "citizen-2" },
    });

    const secondRevoke = await app.inject({
      method: "POST",
      url: `/iam/attachments/${attachmentId}/revoke`,
      payload: { revoked_by: "citizen-2" },
    });

    expect(secondRevoke.statusCode).toBe(409);
    expect(secondRevoke.json()).toHaveProperty("error");
  });
});
