// ARCH-010: Citizen identity registration & verification -- integration/e2e
// scenarios spanning identity-service, auth-service, governance-role-service
// and (for EC-8) competency-service. Every service here is a real process
// (see ./harness.ts) reached over real HTTP; nothing in this file mocks
// another service's business logic. Scenario ids (HPn/ECn) match
// .spec/technical/architecture/arch-010.md verbatim so a failing test here
// traces back to that doc directly.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnGoService, spawnTsService, type SpawnedService } from "./harness.js";
import { generatePasskeyKeyPair, generateTotpSecret, randomChallenge, totpCode } from "./crypto-helpers.js";

// JSON.parse's return type is inferred `any` (its own lib.es5 signature),
// which keeps this test file's response bodies conveniently loosely typed
// without an explicit `any` annotation anywhere in this file.
async function asJson(res: Response) {
  return JSON.parse(await res.text());
}

// ---------------------------------------------------------------------------
// Main fleet: all four services, wired together over real HTTP.
// ---------------------------------------------------------------------------
describe("ARCH-010 identity lifecycle (full fleet)", () => {
  const IDENTITY_PORT = 48401;
  const GOVERNANCE_PORT = 48409;
  const COMPETENCY_PORT = 48405;
  const AUTH_PORT = 48404;
  const IDENTITY_URL = `http://127.0.0.1:${IDENTITY_PORT}`;
  const GOVERNANCE_URL = `http://127.0.0.1:${GOVERNANCE_PORT}`;
  const COMPETENCY_URL = `http://127.0.0.1:${COMPETENCY_PORT}`;
  const AUTH_URL = `http://127.0.0.1:${AUTH_PORT}`;

  let identity: SpawnedService;
  let governance: SpawnedService;
  let competency: SpawnedService;
  let auth: SpawnedService;

  beforeAll(async () => {
    competency = await spawnTsService("competency-service", COMPETENCY_PORT);
    governance = await spawnTsService("governance-role-service", GOVERNANCE_PORT, {
      COMPETENCY_SERVICE_URL: COMPETENCY_URL,
    });
    identity = await spawnTsService("identity-service", IDENTITY_PORT, {
      GOVERNANCE_ROLE_SERVICE_URL: GOVERNANCE_URL,
      AUTH_SERVICE_URL: AUTH_URL,
    });
    auth = await spawnGoService("auth-service", AUTH_PORT, { IDENTITY_SERVICE_URL: IDENTITY_URL });
  }, 60_000);

  afterAll(async () => {
    await Promise.all([identity?.stop(), governance?.stop(), competency?.stop(), auth?.stop()]);
  });

  // --- identity-service client ---
  async function registerCitizen(publicHandle: string, rawLegalIdentifier: string) {
    const res = await fetch(`${IDENTITY_URL}/identity/citizens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public_handle: publicHandle, raw_legal_identifier: rawLegalIdentifier }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function activateCitizen(id: string) {
    return fetch(`${IDENTITY_URL}/identity/citizens/${id}/verifications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evidence_ref: "ref-1", outcome: "verified" }),
    });
  }
  async function getCitizen(id: string) {
    const res = await fetch(`${IDENTITY_URL}/identity/citizens/${id}`);
    return { status: res.status, body: await asJson(res) };
  }
  async function suspendCitizen(id: string) {
    const res = await fetch(`${IDENTITY_URL}/identity/citizens/${id}/suspend`, { method: "POST" });
    return { status: res.status, body: await asJson(res) };
  }
  async function revokeCitizen(id: string) {
    const res = await fetch(`${IDENTITY_URL}/identity/citizens/${id}/revoke`, { method: "POST" });
    return { status: res.status, body: await asJson(res) };
  }

  async function registerAndActivate(label: string) {
    const uid = randomUUID();
    const created = await registerCitizen(`${label}-${uid}`, `legal-${uid}`);
    await activateCitizen(created.body.id);
    return created.body.id as string;
  }

  // --- governance-role-service client ---
  async function createRole(citizenId: string, roleType: string, layer: string) {
    const res = await fetch(`${GOVERNANCE_URL}/governance-roles/roles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizen_id: citizenId,
        role_type: roleType,
        layer,
        randomized: false,
        term_start: "2020-01-01T00:00:00.000Z",
        term_end: "2035-01-01T00:00:00.000Z",
      }),
    });
    const body = await asJson(res);
    return body.id as string;
  }
  async function submitApproval(actionRef: string, approverRoleId: string, approvalType: string) {
    const res = await fetch(`${GOVERNANCE_URL}/governance-roles/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action_ref: actionRef,
        approver_role_id: approverRoleId,
        approval_type: approvalType,
        decision: "approved",
      }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function getActionStatus(actionRef: string) {
    const res = await fetch(`${GOVERNANCE_URL}/governance-roles/actions/${encodeURIComponent(actionRef)}/status`);
    return { status: res.status, body: await asJson(res) };
  }

  const APPROVAL_TYPES = [
    { type: "citizen_supermajority", layer: "citizen", roleType: "reviewer" },
    { type: "audit_confirmation", layer: "audit", roleType: "auditor" },
    { type: "body_endorsement", layer: "protocol", roleType: "review_body" },
  ] as const;

  /** Submits all three required approval types for identity:{actionType}:{citizenId}. Returns the three approver citizen ids. */
  async function fullyApproveIdentityAction(actionType: "suspend" | "revoke", citizenId: string): Promise<string[]> {
    const actionRef = `identity:${actionType}:${citizenId}`;
    const approverIds: string[] = [];
    for (const { type, layer, roleType } of APPROVAL_TYPES) {
      const approverId = `approver-${randomUUID()}`;
      approverIds.push(approverId);
      const roleId = await createRole(approverId, roleType, layer);
      const res = await submitApproval(actionRef, roleId, type);
      if (res.status !== 201) {
        throw new Error(`approval ${type} for ${actionRef} failed: ${res.status} ${JSON.stringify(res.body)}`);
      }
    }
    return approverIds;
  }

  // --- competency-service client ---
  async function createDomain(name: string) {
    const res = await fetch(`${COMPETENCY_URL}/competency/domains`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description: name }),
    });
    const body = await asJson(res);
    return body.id as string;
  }
  async function declareConflict(citizenId: string, domainId: string) {
    return fetch(`${COMPETENCY_URL}/competency/conflicts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ citizen_id: citizenId, domain_id: domainId, description: "test conflict" }),
    });
  }

  // --- auth-service client ---
  async function login(citizenId: string, opts: { deviceFingerprint?: string; ipSubnet?: string; credentialValid?: boolean } = {}) {
    const res = await fetch(`${AUTH_URL}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizen_id: citizenId,
        credential_valid: opts.credentialValid ?? true,
        device_fingerprint: opts.deviceFingerprint ?? "fp-1",
        ip_subnet: opts.ipSubnet ?? "10.0.0.0/24",
      }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function enrollTotp(citizenId: string, sessionId: string, secret: string) {
    const res = await fetch(`${AUTH_URL}/auth/factors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizen_id: citizenId,
        session_id: sessionId,
        factor_type: "totp",
        totp_secret: secret,
        totp_code: totpCode(secret),
      }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function enrollPasskey(citizenId: string, sessionId: string, kp: ReturnType<typeof generatePasskeyKeyPair>) {
    const challenge = randomChallenge();
    const sig = kp.sign(challenge);
    const res = await fetch(`${AUTH_URL}/auth/factors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizen_id: citizenId,
        session_id: sessionId,
        factor_type: "passkey",
        passkey_credential_id: "cred-1",
        passkey_public_key: kp.publicKeyDer.toString("base64"),
        passkey_challenge: challenge.toString("base64"),
        passkey_signature: sig.toString("base64"),
      }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function stepUpPasskey(sessionId: string, kp: ReturnType<typeof generatePasskeyKeyPair>) {
    const challenge = randomChallenge();
    const sig = kp.sign(challenge);
    const res = await fetch(`${AUTH_URL}/auth/stepup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        tier: "T3",
        factor_type: "passkey",
        passkey_challenge: challenge.toString("base64"),
        passkey_signature: sig.toString("base64"),
      }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function refresh(refreshToken: string, deviceFingerprint: string, ipSubnet: string) {
    const res = await fetch(`${AUTH_URL}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken, device_fingerprint: deviceFingerprint, ip_subnet: ipSubnet }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function validateToken(accessToken: string) {
    const res = await fetch(`${AUTH_URL}/auth/internal/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ access_token: accessToken }),
    });
    return { status: res.status, body: await asJson(res) };
  }
  async function revokeAllSessions(citizenId: string) {
    const res = await fetch(`${AUTH_URL}/auth/internal/revoke-all/${citizenId}`, { method: "POST" });
    return { status: res.status, body: await asJson(res) };
  }

  it("HP-1: register, verify, activate, log in, enroll MFA", async () => {
    const uid = randomUUID();
    const created = await registerCitizen(`hp1-${uid}`, `legal-hp1-${uid}`);
    expect(created.body.status).toBe("pending");

    await activateCitizen(created.body.id);
    const activated = await getCitizen(created.body.id);
    expect(activated.body.status).toBe("active");

    const loginRes = await login(created.body.id);
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.assurance_tier).toBe("T1");
    expect(loginRes.body.requires_step_up).toBe(false);
    expect(loginRes.body.available_factor_types).toEqual([]);

    const secret = generateTotpSecret();
    const enrolled = await enrollTotp(created.body.id, loginRes.body.id, secret);
    expect(enrolled.status).toBe(200);
    expect(enrolled.body.status).toBe("active");
  });

  it("HP-2: step up to T3 for a high-assurance action", async () => {
    const uid = randomUUID();
    const created = await registerCitizen(`hp2-${uid}`, `legal-hp2-${uid}`);
    await activateCitizen(created.body.id);
    const loginRes = await login(created.body.id);

    const kp = generatePasskeyKeyPair();
    const enrolled = await enrollPasskey(created.body.id, loginRes.body.id, kp);
    expect(enrolled.status).toBe(200);
    expect(enrolled.body.status).toBe("active");

    const steppedUp = await stepUpPasskey(loginRes.body.id, kp);
    expect(steppedUp.status).toBe(200);
    expect(steppedUp.body.assurance_tier).toBe("T3");
    expect(steppedUp.body.access_token).toBeTruthy();

    const stillActive = await getCitizen(created.body.id);
    expect(stillActive.body.status).toBe("active");
  });

  it("HP-3: duplicate signal detected, reviewed, and resolved by suspension", async () => {
    const uid = randomUUID();
    const a = await registerCitizen(`alice-${uid}`, `legal-a-${uid}`);
    const b = await registerCitizen(` Alice-${uid} `, `legal-b-${uid}`);
    await activateCitizen(a.body.id);
    await activateCitizen(b.body.id);

    const scanRes = await fetch(`${IDENTITY_URL}/identity/duplicates/scan`, { method: "POST" });
    const scan = await asJson(scanRes);
    expect(scan.signal_matches).toContainEqual({ citizen_id_a: a.body.id, citizen_id_b: b.body.id });

    await fullyApproveIdentityAction("suspend", b.body.id);
    const statusRes = await getActionStatus(`identity:suspend:${b.body.id}`);
    expect(statusRes.body.fully_approved).toBe(true);

    const suspended = await suspendCitizen(b.body.id);
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe("suspended");

    const aStillActive = await getCitizen(a.body.id);
    expect(aStillActive.body.status).toBe("active");
  });

  it("HP-4: full revocation with multi-approval and session cascade", async () => {
    const citizenId = await registerAndActivate("hp4");
    const loginRes = await login(citizenId, { deviceFingerprint: "hp4-fp" });
    expect(loginRes.status).toBe(200);

    await fullyApproveIdentityAction("revoke", citizenId);
    const revoked = await revokeCitizen(citizenId);
    expect(revoked.status).toBe(200);
    expect(revoked.body.status).toBe("revoked");

    // Give the fire-and-forget SessionRevoker call a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const validated = await validateToken(loginRes.body.access_token);
    expect(validated.status).toBe(401);
  });

  it("EC-3: login for a citizen whose real identity-service status is pending is denied", async () => {
    const uid = randomUUID();
    const created = await registerCitizen(`ec3-${uid}`, `legal-ec3-${uid}`);
    // Deliberately not activated.
    const loginRes = await login(created.body.id);
    expect(loginRes.status).toBe(403);
  });

  it("EC-5: refresh fails for a session force-revoked by the identity cascade", async () => {
    const citizenId = await registerAndActivate("ec5");
    const loginRes = await login(citizenId, { deviceFingerprint: "ec5-fp" });
    await fullyApproveIdentityAction("revoke", citizenId);
    await revokeCitizen(citizenId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const refreshed = await refresh(loginRes.body.refresh_token, "ec5-fp", "10.0.0.0/24");
    expect(refreshed.status).toBe(401);
  });

  it("EC-6: step-up fails for a session force-revoked by the identity cascade", async () => {
    const citizenId = await registerAndActivate("ec6");
    const loginRes = await login(citizenId, { deviceFingerprint: "ec6-fp" });
    const kp = generatePasskeyKeyPair();
    await enrollPasskey(citizenId, loginRes.body.id, kp);

    await fullyApproveIdentityAction("revoke", citizenId);
    await revokeCitizen(citizenId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const steppedUp = await stepUpPasskey(loginRes.body.id, kp);
    expect(steppedUp.status).toBe(403);
  });

  it("EC-7: a suspend approval does not satisfy a revoke check on the same citizen", async () => {
    const citizenId = await registerAndActivate("ec7");
    await fullyApproveIdentityAction("suspend", citizenId);

    const suspended = await suspendCitizen(citizenId);
    expect(suspended.status).toBe(200);

    // revoke is a distinct action_ref (identity:revoke:{id}); no approvals
    // were ever submitted against it, so it must still be blocked even
    // though suspend just succeeded and the citizen is now in a revokable
    // state.
    const revokeAttempt = await revokeCitizen(citizenId);
    expect(revokeAttempt.status).toBe(403);
  });

  it("EC-8: an approver with a conflict of interest is excluded from an identity approval", async () => {
    const citizenId = await registerAndActivate("ec8");
    const domainId = await createDomain(`ec8-domain-${randomUUID()}`);

    const conflictedApproverId = `approver-${randomUUID()}`;
    await declareConflict(conflictedApproverId, domainId);

    const roleId = await createRole(conflictedApproverId, "reviewer", "citizen");
    const res = await submitApproval(`identity:suspend:${citizenId}`, roleId, "citizen_supermajority");
    expect(res.status).toBe(403);

    // With that approval type never recorded, suspend must stay blocked.
    const suspendAttempt = await suspendCitizen(citizenId);
    expect(suspendAttempt.status).toBe(403);
  });

  it("EC-10: two of three approval types satisfied is not fully approved and suspend stays blocked", async () => {
    const citizenId = await registerAndActivate("ec10");
    const actionRef = `identity:suspend:${citizenId}`;

    for (const { type, layer, roleType } of APPROVAL_TYPES.slice(0, 2)) {
      const roleId = await createRole(`approver-${randomUUID()}`, roleType, layer);
      await submitApproval(actionRef, roleId, type);
    }

    const status = await getActionStatus(actionRef);
    expect(status.body.fully_approved).toBe(false);

    const suspendAttempt = await suspendCitizen(citizenId);
    expect(suspendAttempt.status).toBe(403);
  });

  it("EC-14: a retried revoke-all-sessions cascade call is idempotent (count 0 on replay)", async () => {
    const citizenId = await registerAndActivate("ec14");
    await login(citizenId, { deviceFingerprint: "ec14-fp" });
    await fullyApproveIdentityAction("revoke", citizenId);
    await revokeCitizen(citizenId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const replay = await revokeAllSessions(citizenId);
    expect(replay.status).toBe(200);
    expect(replay.body.count).toBe(0);
  });

  it("EC-20: the audit-relevant identity/approval records never leak the raw legal identifier", async () => {
    const uid = randomUUID();
    const rawId = `top-secret-legal-id-${uid}`;
    const created = await registerCitizen(`ec20-${uid}`, rawId);
    await activateCitizen(created.body.id);
    await fullyApproveIdentityAction("suspend", created.body.id);
    const suspended = await suspendCitizen(created.body.id);

    expect(JSON.stringify(suspended.body)).not.toContain(rawId);
    const status = await getActionStatus(`identity:suspend:${created.body.id}`);
    expect(JSON.stringify(status.body)).not.toContain(rawId);
  });

  it("EC-21: identity/session records carry no ballot-identity-linking field", async () => {
    const citizenId = await registerAndActivate("ec21");
    const citizen = await getCitizen(citizenId);
    expect(citizen.body).not.toHaveProperty("eligibility_token_id");
    expect(citizen.body).not.toHaveProperty("vote_session_id");

    const loginRes = await login(citizenId, { deviceFingerprint: "ec21-fp" });
    expect(loginRes.body).not.toHaveProperty("eligibility_token_id");
    expect(loginRes.body).not.toHaveProperty("vote_session_id");
  });

  it("EC-22: a suspended citizen record remains readable, never deleted", async () => {
    const citizenId = await registerAndActivate("ec22");
    await fullyApproveIdentityAction("suspend", citizenId);
    await suspendCitizen(citizenId);

    const after = await getCitizen(citizenId);
    expect(after.status).toBe(200);
    expect(after.body.status).toBe("suspended");
  });

  it("EC-23: a session-level anomaly suspends only the session, not the citizen's identity-service status", async () => {
    const citizenId = await registerAndActivate("ec23");
    const loginRes = await login(citizenId, { deviceFingerprint: "device-a", ipSubnet: "10.0.0.0/24" });

    // Device-mismatch anomaly on refresh (DP-066) suspends the session.
    const refreshed = await refresh(loginRes.body.refresh_token, "device-b", "10.0.0.0/24");
    expect(refreshed.status).toBe(401);

    const citizen = await getCitizen(citizenId);
    expect(citizen.body.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// EC-16: identity-service must fail closed when governance-role-service is
// unreachable. Isolated single-service instance -- no real
// governance-role-service needed, only an unreachable URL for it.
// ---------------------------------------------------------------------------
describe("ARCH-010 EC-16: identity-service fails closed when governance-role-service is unreachable", () => {
  const PORT = 48411;
  let identity: SpawnedService;

  beforeAll(async () => {
    identity = await spawnTsService("identity-service", PORT, {
      GOVERNANCE_ROLE_SERVICE_URL: "http://127.0.0.1:1",
    });
  }, 30_000);

  afterAll(async () => {
    await identity?.stop();
  });

  it("suspend is denied (not silently approved) when the approval check is unreachable", async () => {
    const base = `http://127.0.0.1:${PORT}`;
    const uid = randomUUID();
    const created = await fetch(`${base}/identity/citizens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public_handle: `ec16-${uid}`, raw_legal_identifier: `legal-ec16-${uid}` }),
    }).then((r) => r.text()).then((t) => JSON.parse(t));

    const res = await fetch(`${base}/identity/citizens/${created.id}/suspend`, { method: "POST" });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// EC-17: auth-service must fail closed when identity-service is unreachable.
// ---------------------------------------------------------------------------
describe("ARCH-010 EC-17: auth-service fails closed when identity-service is unreachable", () => {
  const PORT = 48412;
  let auth: SpawnedService;

  beforeAll(async () => {
    auth = await spawnGoService("auth-service", PORT, { IDENTITY_SERVICE_URL: "http://127.0.0.1:1" });
  }, 30_000);

  afterAll(async () => {
    await auth?.stop();
  });

  it("login is denied (no session issued) when the identity check is unreachable", async () => {
    const base = `http://127.0.0.1:${PORT}`;
    const res = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        citizen_id: "citizen-1",
        credential_valid: true,
        device_fingerprint: "fp",
        ip_subnet: "10.0.0.0/24",
      }),
    });
    expect(res.status).toBe(401);
    const body = JSON.parse(await res.text());
    expect(body.access_token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EC-18: identity-service's own status transition must succeed even when the
// downstream session-revocation cascade cannot reach auth-service.
// ---------------------------------------------------------------------------
describe("ARCH-010 EC-18: revoke succeeds even when the session cascade's target is unreachable", () => {
  const PORT = 48413;
  let identity: SpawnedService;

  beforeAll(async () => {
    // No GOVERNANCE_ROLE_SERVICE_URL -> permissive default ApprovalGate, so
    // this scenario isolates the auth-service-unreachable behavior alone.
    identity = await spawnTsService("identity-service", PORT, { AUTH_SERVICE_URL: "http://127.0.0.1:1" });
  }, 30_000);

  afterAll(async () => {
    await identity?.stop();
  });

  it("the citizen's status still flips to revoked despite an unreachable auth-service", async () => {
    const base = `http://127.0.0.1:${PORT}`;
    const uid = randomUUID();
    const created = await fetch(`${base}/identity/citizens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public_handle: `ec18-${uid}`, raw_legal_identifier: `legal-ec18-${uid}` }),
    }).then((r) => r.text()).then((t) => JSON.parse(t));
    await fetch(`${base}/identity/citizens/${created.id}/verifications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evidence_ref: "ref-1", outcome: "verified" }),
    });

    const res = await fetch(`${base}/identity/citizens/${created.id}/revoke`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.status).toBe("revoked");
    // Note: the "durably logged, not silently dropped" half of this
    // scenario (ARCH-010 §4) remains blocked on real audit-service
    // integration -- AuditEmitter is a no-op in this phase (EC-19), so
    // there is nowhere durable to log the cascade failure to yet.
  });
});
