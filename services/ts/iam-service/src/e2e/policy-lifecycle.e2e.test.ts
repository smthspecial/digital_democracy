// ADR-025 / ARCH-024: iam-service's dual-control policy + attachment
// lifecycle, proven end to end against real processes only -- a real
// nats-server (JetStream), a real governance-role-service (TS, the live
// GovernanceRoleChecker dependency ARCH-024 §2 requires), a real iam-service
// (TS, the system under test) wired to both, and a real audit-service (Go)
// consuming iam-service's published events into its real hash chain. No
// mocked business logic anywhere in this chain (ARCH-009 §2), matching
// proposal-service's own async-audit-queue.e2e.test.ts, whose harness.ts is
// reused unchanged.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnGoService, spawnNatsServer, spawnTsService, type SpawnedService } from "./harness.js";

async function asJson(res: Response) {
  return JSON.parse(await res.text());
}

async function waitFor<T>(check: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await check();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  return last!;
}

describe("ADR-025/ARCH-024 iam-service dual-control lifecycle (real nats-server + governance-role-service + iam-service + audit-service)", () => {
  // A fresh port range (48900s) that doesn't collide with any other e2e
  // suite in this repo -- proposal-service's own suites use 485xx/486xx/487xx,
  // identity-service's use 484xx -- so this suite can run concurrently with
  // either in CI without a port clash.
  const NATS_PORT = 48900;
  const GOVERNANCE_PORT = 48902;
  const IAM_PORT = 48904;
  const AUDIT_PORT = 48906;
  const NATS_URL = `nats://127.0.0.1:${NATS_PORT}`;
  const GOVERNANCE_URL = `http://127.0.0.1:${GOVERNANCE_PORT}`;
  const IAM_URL = `http://127.0.0.1:${IAM_PORT}`;
  const AUDIT_URL = `http://127.0.0.1:${AUDIT_PORT}`;

  let nats: SpawnedService;
  let governance: SpawnedService;
  let iam: SpawnedService;
  let audit: SpawnedService;

  // Shared across the lettered scenarios below -- this is one continuous
  // dual-control lifecycle (propose -> endorse -> attach -> evaluate ->
  // revoke -> evaluate again), not independent fixtures, so state
  // deliberately threads through module-level `let`s the same way
  // proposal-service's arch010/012 e2e suites thread proposal/problem ids
  // across their own dependent `it` blocks.
  let citizenA: string; // proposes the policy and the attachment (operator)
  let citizenB: string; // endorses both (operator, distinct from A)
  let citizenAuditor: string; // auditor-only -- can revoke, cannot endorse
  let policyId: string;
  let attachmentId: string;
  const testPrincipalRef = `citizen:${randomUUID()}`;
  const TEST_ACTION = "iam-e2e:read";
  const TEST_RESOURCE = "iam-e2e:widgets";

  beforeAll(async () => {
    nats = await spawnNatsServer(NATS_PORT);
    audit = await spawnGoService("audit-service", AUDIT_PORT, { NATS_URL });
    governance = await spawnTsService("governance-role-service", GOVERNANCE_PORT);
    iam = await spawnTsService("iam-service", IAM_PORT, {
      GOVERNANCE_ROLE_SERVICE_URL: GOVERNANCE_URL,
      NATS_URL,
    });

    citizenA = randomUUID();
    citizenB = randomUUID();
    citizenAuditor = randomUUID();
    // Layer mapping per ARCH-024 §2: operator/platform_operator live at the
    // 'implementation' layer, auditor at the 'audit' layer.
    await createGovernanceRole(citizenA, "operator", "implementation");
    await createGovernanceRole(citizenB, "operator", "implementation");
    await createGovernanceRole(citizenAuditor, "auditor", "audit");
  }, 60_000);

  afterAll(async () => {
    await Promise.all([iam?.stop(), governance?.stop(), audit?.stop(), nats?.stop()]);
  });

  // --- governance-role-service client ---
  async function createGovernanceRole(citizenId: string, roleType: string, layer: string) {
    const now = Date.now();
    const res = await fetch(`${GOVERNANCE_URL}/governance-roles/roles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizen_id: citizenId,
        role_type: roleType,
        layer,
        randomized: false,
        // Comfortably covers "now": started an hour ago, ends a year from now.
        term_start: new Date(now - 60 * 60 * 1000).toISOString(),
        term_end: new Date(now + 365 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    });
    if (res.status !== 201) {
      throw new Error(`failed to create ${roleType} governance role: ${res.status} ${await res.text()}`);
    }
    return asJson(res);
  }

  // --- iam-service client ---
  async function proposePolicy(proposedBy: string) {
    const res = await fetch(`${IAM_URL}/iam/policies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "iam-e2e-policy",
        effect: "allow",
        actions: [TEST_ACTION],
        resources: [TEST_RESOURCE],
        description: "iam-service e2e dual-control lifecycle policy",
        proposed_by: proposedBy,
      }),
    });
    return { status: res.status, body: await asJson(res) };
  }

  async function endorsePolicy(id: string, endorserCitizenId: string, decision: "approved" | "rejected") {
    const res = await fetch(`${IAM_URL}/iam/policies/${id}/endorsements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endorser_citizen_id: endorserCitizenId, decision }),
    });
    return { status: res.status, body: await asJson(res) };
  }

  async function proposeAttachment(forPolicyId: string, principalRef: string, proposedBy: string) {
    const res = await fetch(`${IAM_URL}/iam/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy_id: forPolicyId, principal_ref: principalRef, proposed_by: proposedBy }),
    });
    return { status: res.status, body: await asJson(res) };
  }

  async function endorseAttachment(id: string, endorserCitizenId: string, decision: "approved" | "rejected") {
    const res = await fetch(`${IAM_URL}/iam/attachments/${id}/endorsements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endorser_citizen_id: endorserCitizenId, decision }),
    });
    return { status: res.status, body: await asJson(res) };
  }

  async function revokeAttachment(id: string, revokedBy: string) {
    const res = await fetch(`${IAM_URL}/iam/attachments/${id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revoked_by: revokedBy }),
    });
    return { status: res.status, body: await asJson(res) };
  }

  async function evaluate(principalRef: string, action: string, resource: string) {
    const res = await fetch(`${IAM_URL}/iam/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principal_ref: principalRef, action, resource }),
    });
    return { status: res.status, body: await asJson(res) };
  }

  // --- audit-service client ---
  async function listAuditLog(actionType: string): Promise<Array<Record<string, unknown>>> {
    const res = await fetch(`${AUDIT_URL}/audit/log?action_type=${actionType}`);
    const body = await asJson(res);
    return body.entries ?? [];
  }

  it("a: A proposes a policy (pending_approval); B, a distinct operator, endorses it and it activates", async () => {
    // Every iam-service audit payload includes a server-generated
    // `occurredAt` timestamp (services/policies.ts), so -- unlike
    // proposal-service's proposal_created payload -- the exact payload_hash
    // audit-service stores can't be recomputed from outside the process
    // (audit-service never stores the raw payload, only its hash --
    // AuditLogEntry in domain.go). This mirrors this same suite's own
    // async-audit-queue.e2e.test.ts precedent for identity-service's
    // registerCitizen event: correlate by count + attribution instead of by
    // exact hash. Every admin_action entry in *this* audit-service instance
    // can only have come from *this* iam-service (nothing else in this
    // suite writes admin_action), so a plain count increase is a genuine
    // proof that the real propose/endorse calls below really published to
    // the real queue and were really consumed into the real chain.
    const before = await listAuditLog("admin_action");

    const proposed = await proposePolicy(citizenA);
    expect(proposed.status).toBe(201);
    expect(proposed.body.status).toBe("pending_approval");
    expect(proposed.body.proposed_by).toBe(citizenA);
    expect(proposed.body.proposer_role_type).toBe("operator");
    policyId = proposed.body.id;

    // policy.proposed landed (real HTTP propose -> real NATS publish -> real
    // audit-service consume).
    const afterPropose = await waitFor(
      () => listAuditLog("admin_action"),
      (list) => list.length >= before.length + 1,
    );
    expect(afterPropose.every((e) => e.actor_ref === "iam-service")).toBe(true);

    const endorsed = await endorsePolicy(policyId, citizenB, "approved");
    expect(endorsed.status).toBe(201);
    expect(endorsed.body.policy.status).toBe("active");
    expect(endorsed.body.endorsement.endorser_citizen_id).toBe(citizenB);

    // policy.activated landed too -- a second, distinct admin_action entry.
    const afterEndorse = await waitFor(
      () => listAuditLog("admin_action"),
      (list) => list.length >= before.length + 2,
    );
    expect(afterEndorse.every((e) => e.actor_ref === "iam-service")).toBe(true);
  });

  it("b: a citizen holding only an auditor role cannot endorse A's policy (real 403)", async () => {
    // assertCanEndorse (dual-control.ts) checks role-type eligibility before
    // the target's status, so this 403 fires even though the policy is
    // already active by this point -- proving the *role_type* check itself,
    // not incidentally a status conflict.
    const res = await endorsePolicy(policyId, citizenAuditor, "approved");
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });

  it("c: an attachment is proposed against the active policy and activates via a second operator's endorsement", async () => {
    const proposed = await proposeAttachment(policyId, testPrincipalRef, citizenA);
    expect(proposed.status).toBe(201);
    expect(proposed.body.status).toBe("pending_approval");
    expect(proposed.body.policy_id).toBe(policyId);
    expect(proposed.body.principal_ref).toBe(testPrincipalRef);
    attachmentId = proposed.body.id;

    const endorsed = await endorseAttachment(attachmentId, citizenB, "approved");
    expect(endorsed.status).toBe(201);
    expect(endorsed.body.attachment.status).toBe("active");
  });

  it("d: /iam/evaluate allows while the attachment is active; the auditor revokes it unilaterally; evaluate then denies", async () => {
    const allowed = await evaluate(testPrincipalRef, TEST_ACTION, TEST_RESOURCE);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ effect: "allow", matched_policy_id: policyId });

    // Unilateral revoke -- a single real HTTP call from the auditor citizen,
    // no endorsement/dual-control step, per DP-072's grant/revoke asymmetry.
    const revoked = await revokeAttachment(attachmentId, citizenAuditor);
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe("revoked");

    const denied = await evaluate(testPrincipalRef, TEST_ACTION, TEST_RESOURCE);
    expect(denied.status).toBe(200);
    expect(denied.body).toEqual({ effect: "deny", matched_policy_id: null });
  });

  it("e: audit-service's real hash chain is still valid after every propose/endorse/revoke event iam-service published", async () => {
    // Five governance-relevant transitions happened above: policy.proposed,
    // policy.activated, attachment.proposed, attachment.activated,
    // attachment.revoked -- all mapped to admin_action (collaborators.ts).
    // evaluate() calls are deliberately never audited (ARCH-024 §4's last
    // paragraph), so they must not have added any entries.
    const entries = await waitFor(
      () => listAuditLog("admin_action"),
      (list) => list.length >= 5,
    );
    expect(entries.length).toBeGreaterThanOrEqual(5);
    expect(entries.every((e) => e.actor_ref === "iam-service")).toBe(true);

    const verifyRes = await fetch(`${AUDIT_URL}/audit/log/verify`);
    const verify = await asJson(verifyRes);
    expect(verify.valid).toBe(true);
    expect(verify.broken_at).toBeNull();
  });
});
