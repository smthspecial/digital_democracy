import { describe, expect, it, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createStore } from "../store.js";
import type { AuditEmitter, AuditEvent } from "../collaborators.js";
import { createDefaultDuplicateSignal, createDefaultIdentityHasher } from "../collaborators.js";
import type { IdentityServiceDeps } from "../services/identity.js";

function buildTestServer(overrides: Partial<IdentityServiceDeps> = {}): FastifyInstance {
  return buildServer({
    store: createStore(),
    hasher: createDefaultIdentityHasher(),
    approvalGate: { hasRequiredApprovals: () => true },
    audit: { append: () => {} },
    duplicateSignal: createDefaultDuplicateSignal(),
    ...overrides,
  });
}

function createSpyAudit(): { audit: AuditEmitter; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { audit: { append: (event) => events.push(event) }, events };
}

async function registerCitizen(
  app: FastifyInstance,
  overrides: Partial<{ public_handle: string; raw_legal_identifier: string }> = {},
) {
  const res = await app.inject({
    method: "POST",
    url: "/identity/citizens",
    payload: {
      public_handle: overrides.public_handle ?? "alice",
      raw_legal_identifier: overrides.raw_legal_identifier ?? "raw-id-1",
    },
  });
  return res;
}

let currentApp: FastifyInstance | undefined;

afterEach(async () => {
  await currentApp?.close();
  currentApp = undefined;
});

describe("POST /identity/citizens", () => {
  // ARCH-010 EC-1: schema validation rejects before any handler code runs,
  // so no downstream approval-gate or session-revoker call is a possible
  // side effect of a malformed registration request.
  it("IT-010-EC-1: rejects a missing raw_legal_identifier with 400 and calls no downstream collaborator", async () => {
    const approvalGateSpy = { hasRequiredApprovals: () => true };
    const sessionRevokerSpy = { revokeAllSessions: () => {} };
    const approvalCalls: unknown[] = [];
    const revokeCalls: unknown[] = [];
    const app = (currentApp = buildTestServer({
      approvalGate: {
        hasRequiredApprovals: (...args) => {
          approvalCalls.push(args);
          return approvalGateSpy.hasRequiredApprovals();
        },
      },
      sessionRevoker: {
        revokeAllSessions: (...args) => {
          revokeCalls.push(args);
          sessionRevokerSpy.revokeAllSessions();
        },
      },
    }));

    const res = await app.inject({
      method: "POST",
      url: "/identity/citizens",
      payload: { public_handle: "alice" },
    });

    expect(res.statusCode).toBe(400);
    expect(approvalCalls).toEqual([]);
    expect(revokeCalls).toEqual([]);
  });

  it("IT-010-EC-1: rejects an empty public_handle with 400", async () => {
    const app = (currentApp = buildTestServer());
    const res = await app.inject({
      method: "POST",
      url: "/identity/citizens",
      payload: { public_handle: "", raw_legal_identifier: "raw-id-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ARCH-010 EC-13: registerCitizen's check-then-write has no await between
  // the duplicate-hash check and the insert, so two "concurrent" requests
  // (fired without awaiting the first) still serialize on Node's single
  // event loop turn -- this is a regression guard for that invariant, not a
  // guarantee that would survive a real async/DB-backed store.
  it("IT-010-EC-13: two concurrent registrations with the same legal identifier admit only one citizen", async () => {
    const app = (currentApp = buildTestServer());
    const [first, second] = await Promise.all([
      registerCitizen(app, { public_handle: "alice", raw_legal_identifier: "concurrent-id" }),
      registerCitizen(app, { public_handle: "bob", raw_legal_identifier: "concurrent-id" }),
    ]);
    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const list = await app.inject({ method: "GET", url: "/identity/citizens" });
    expect(list.json()).toHaveLength(1);
  });

  it("registers a new citizen with status pending", async () => {
    const app = (currentApp = buildTestServer());
    const res = await registerCitizen(app, { public_handle: "alice" });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.public_handle).toBe("alice");
    expect(body.status).toBe("pending");
    expect(typeof body.id).toBe("string");
    expect(typeof body.created_at).toBe("string");
  });

  it("rejects an exact duplicate legal identifier with 409", async () => {
    const app = (currentApp = buildTestServer());
    await registerCitizen(app, { public_handle: "alice", raw_legal_identifier: "same-id" });
    const res = await registerCitizen(app, { public_handle: "bob", raw_legal_identifier: "same-id" });

    expect(res.statusCode).toBe(409);
  });

  it("never leaks the raw legal identifier in the response body", async () => {
    const app = (currentApp = buildTestServer());
    const res = await registerCitizen(app, { raw_legal_identifier: "top-secret-ssn" });

    expect(JSON.stringify(res.json())).not.toContain("top-secret-ssn");
  });

  it("never leaks the raw legal identifier across the full lifecycle of responses", async () => {
    const app = (currentApp = buildTestServer());
    const rawId = "top-secret-ssn-2";
    const created = await registerCitizen(app, { raw_legal_identifier: rawId });
    const id = created.json().id as string;

    const responses = await Promise.all([
      app.inject({ method: "GET", url: `/identity/citizens/${id}` }),
      app.inject({ method: "GET", url: "/identity/citizens" }),
      app.inject({
        method: "POST",
        url: `/identity/citizens/${id}/verifications`,
        payload: { evidence_ref: "ref-1", outcome: "verified" },
      }),
      app.inject({ method: "POST", url: "/identity/duplicates/scan" }),
    ]);

    for (const res of responses) {
      expect(JSON.stringify(res.json())).not.toContain(rawId);
    }
  });
});

describe("GET /identity/citizens", () => {
  it("lists registered citizens", async () => {
    const app = (currentApp = buildTestServer());
    await registerCitizen(app, { public_handle: "alice", raw_legal_identifier: "id-a" });
    await registerCitizen(app, { public_handle: "bob", raw_legal_identifier: "id-b" });

    const res = await app.inject({ method: "GET", url: "/identity/citizens" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });
});

describe("GET /identity/citizens/:id", () => {
  it("returns the citizen by id", async () => {
    const app = (currentApp = buildTestServer());
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    const res = await app.inject({ method: "GET", url: `/identity/citizens/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
  });

  it("returns 404 for an unknown citizen", async () => {
    const app = (currentApp = buildTestServer());
    const res = await app.inject({ method: "GET", url: "/identity/citizens/00000000-0000-0000-0000-000000000000" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /identity/citizens/:id/verifications", () => {
  it("activates the citizen on the first verified record", async () => {
    const app = (currentApp = buildTestServer());
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    const res = await app.inject({
      method: "POST",
      url: `/identity/citizens/${id}/verifications`,
      payload: { evidence_ref: "ref-1", outcome: "verified" },
    });
    expect(res.statusCode).toBe(201);

    const citizenRes = await app.inject({ method: "GET", url: `/identity/citizens/${id}` });
    expect(citizenRes.json().status).toBe("active");
  });

  it("does not activate the citizen on a rejected record", async () => {
    const app = (currentApp = buildTestServer());
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    await app.inject({
      method: "POST",
      url: `/identity/citizens/${id}/verifications`,
      payload: { evidence_ref: "ref-1", outcome: "rejected" },
    });

    const citizenRes = await app.inject({ method: "GET", url: `/identity/citizens/${id}` });
    expect(citizenRes.json().status).toBe("pending");
  });

  it("does not re-run activation on a second verified record", async () => {
    const { audit, events } = createSpyAudit();
    const app = (currentApp = buildTestServer({ audit }));
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    await app.inject({
      method: "POST",
      url: `/identity/citizens/${id}/verifications`,
      payload: { evidence_ref: "ref-1", outcome: "verified" },
    });
    const res2 = await app.inject({
      method: "POST",
      url: `/identity/citizens/${id}/verifications`,
      payload: { evidence_ref: "ref-2", outcome: "verified" },
    });

    expect(res2.statusCode).toBe(201);
    const citizenRes = await app.inject({ method: "GET", url: `/identity/citizens/${id}` });
    expect(citizenRes.json().status).toBe("active");
    expect(events.filter((e) => e.action === "activated")).toHaveLength(1);
  });

  it("returns 404 when submitting a verification for an unknown citizen", async () => {
    const app = (currentApp = buildTestServer());
    const res = await app.inject({
      method: "POST",
      url: "/identity/citizens/00000000-0000-0000-0000-000000000000/verifications",
      payload: { evidence_ref: "ref-1", outcome: "verified" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe.each([
  { action: "suspend" as const, expectedStatus: "suspended" },
  { action: "revoke" as const, expectedStatus: "revoked" },
])("POST /identity/citizens/:id/$action", ({ action, expectedStatus }) => {
  it(`blocks ${action} without required approvals (403)`, async () => {
    const app = (currentApp = buildTestServer({ approvalGate: { hasRequiredApprovals: () => false } }));
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    const res = await app.inject({ method: "POST", url: `/identity/citizens/${id}/${action}` });
    expect(res.statusCode).toBe(403);
  });

  it(`allows ${action} with required approvals`, async () => {
    const app = (currentApp = buildTestServer({ approvalGate: { hasRequiredApprovals: () => true } }));
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    const res = await app.inject({ method: "POST", url: `/identity/citizens/${id}/${action}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe(expectedStatus);
  });

  it(`revokes the citizen's active sessions on ${action} (DP-042 cascade)`, async () => {
    const revoked: string[] = [];
    const app = (currentApp = buildTestServer({
      approvalGate: { hasRequiredApprovals: () => true },
      sessionRevoker: { revokeAllSessions: (citizenId) => revoked.push(citizenId) },
    }));
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    const res = await app.inject({ method: "POST", url: `/identity/citizens/${id}/${action}` });
    expect(res.statusCode).toBe(200);
    expect(revoked).toEqual([id]);
  });

  it(`does not revoke sessions when ${action} is blocked by missing approvals`, async () => {
    const revoked: string[] = [];
    const app = (currentApp = buildTestServer({
      approvalGate: { hasRequiredApprovals: () => false },
      sessionRevoker: { revokeAllSessions: (citizenId) => revoked.push(citizenId) },
    }));
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    const res = await app.inject({ method: "POST", url: `/identity/citizens/${id}/${action}` });
    expect(res.statusCode).toBe(403);
    expect(revoked).toEqual([]);
  });
});

// ARCH-010 EC-4: a fully-approved re-suspend of an already-suspended or
// already-revoked citizen, or a re-revoke of an already-revoked one, must
// reject with 409 rather than silently overwriting a stronger status or
// double-processing an already-completed transition.
describe("ARCH-010 EC-4: illegal status transitions on suspend/revoke", () => {
  it("IT-010-EC-4: rejects double-suspending an already-suspended citizen", async () => {
    const app = (currentApp = buildTestServer({ approvalGate: { hasRequiredApprovals: () => true } }));
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    const first = await app.inject({ method: "POST", url: `/identity/citizens/${id}/suspend` });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "POST", url: `/identity/citizens/${id}/suspend` });
    expect(second.statusCode).toBe(409);
  });

  it("IT-010-EC-4: rejects re-suspending an already-revoked citizen (does not overwrite revoked back to suspended)", async () => {
    const app = (currentApp = buildTestServer({ approvalGate: { hasRequiredApprovals: () => true } }));
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    await app.inject({ method: "POST", url: `/identity/citizens/${id}/revoke` });
    const res = await app.inject({ method: "POST", url: `/identity/citizens/${id}/suspend` });
    expect(res.statusCode).toBe(409);

    const citizen = await app.inject({ method: "GET", url: `/identity/citizens/${id}` });
    expect(citizen.json().status).toBe("revoked");
  });

  it("IT-010-EC-4: rejects re-revoking an already-revoked citizen", async () => {
    const app = (currentApp = buildTestServer({ approvalGate: { hasRequiredApprovals: () => true } }));
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    const first = await app.inject({ method: "POST", url: `/identity/citizens/${id}/revoke` });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: "POST", url: `/identity/citizens/${id}/revoke` });
    expect(second.statusCode).toBe(409);
  });

  // ARCH-010 EC-15: this state-machine guard also closes the double-audit gap
  // EC-15 originally described -- a retried suspend/revoke call now rejects
  // cleanly with 409 instead of re-applying the same status update and
  // re-emitting a second audit event for one logical transition.
  it("IT-010-EC-15: a replayed suspend call (client retry after a dropped response) does not double-process or double-audit", async () => {
    const { audit, events } = createSpyAudit();
    const app = (currentApp = buildTestServer({ approvalGate: { hasRequiredApprovals: () => true }, audit }));
    const created = await registerCitizen(app);
    const id = created.json().id as string;

    await app.inject({ method: "POST", url: `/identity/citizens/${id}/suspend` });
    const replay = await app.inject({ method: "POST", url: `/identity/citizens/${id}/suspend` });

    expect(replay.statusCode).toBe(409);
    expect(events.filter((e) => e.action === "suspended")).toHaveLength(1);
  });
});

describe("POST /identity/duplicates/scan", () => {
  it("flags citizens sharing the same legal_identity_hash", async () => {
    const store = createStore();
    const app = (currentApp = buildTestServer({ store }));
    const now = new Date();
    store.insertCitizen({ id: "c1", publicHandle: "alice", legalIdentityHash: "hash-x", status: "pending", createdAt: now });
    store.insertCitizen({ id: "c2", publicHandle: "carl", legalIdentityHash: "hash-x", status: "pending", createdAt: now });
    store.insertCitizen({ id: "c3", publicHandle: "dana", legalIdentityHash: "hash-y", status: "pending", createdAt: now });

    const res = await app.inject({ method: "POST", url: "/identity/duplicates/scan" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hash_matches).toHaveLength(1);
    expect(body.hash_matches[0].citizen_ids.sort()).toEqual(["c1", "c2"]);
  });

  it("flags citizens matching the default heuristic (normalized public_handle) even with different hashes", async () => {
    const store = createStore();
    const app = (currentApp = buildTestServer({ store }));
    const now = new Date();
    store.insertCitizen({ id: "c1", publicHandle: "Alice", legalIdentityHash: "hash-a", status: "pending", createdAt: now });
    store.insertCitizen({ id: "c2", publicHandle: " alice ", legalIdentityHash: "hash-b", status: "pending", createdAt: now });

    const res = await app.inject({ method: "POST", url: "/identity/duplicates/scan" });
    const body = res.json();
    expect(body.signal_matches).toEqual([{ citizen_id_a: "c1", citizen_id_b: "c2" }]);
    expect(body.hash_matches).toHaveLength(0);
  });

  it("returns empty groups when there are no duplicates", async () => {
    const app = (currentApp = buildTestServer());
    await registerCitizen(app, { public_handle: "alice", raw_legal_identifier: "id-a" });
    await registerCitizen(app, { public_handle: "bob", raw_legal_identifier: "id-b" });

    const res = await app.inject({ method: "POST", url: "/identity/duplicates/scan" });
    const body = res.json();
    expect(body.hash_matches).toHaveLength(0);
    expect(body.signal_matches).toHaveLength(0);
  });

  // ARCH-010 EC-11: zero/empty-population boundary.
  it("IT-010-EC-11: against zero registered citizens, returns 200 with empty matches and emits no duplicates_flagged event", async () => {
    const { audit, events } = createSpyAudit();
    const app = (currentApp = buildTestServer({ audit }));

    const res = await app.inject({ method: "POST", url: "/identity/duplicates/scan" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hash_matches).toEqual([]);
    expect(body.signal_matches).toEqual([]);
    expect(events.filter((e) => e.action === "duplicates_flagged")).toHaveLength(0);
  });
});

// ARCH-010 EC-19: every AuditEmitter in this flow (identity-service,
// auth-service, governance-role-service) is a no-op today, so "does the
// citizen-facing action still complete if the audit call fails" is moot --
// a no-op cannot fail. This is intentionally left undecided rather than
// tested against fabricated behavior; it becomes answerable once a real
// audit-service HTTP integration exists to fail against (ARCH-009 §2).
it.todo(
  "IT-010-EC-19 [blocked on: real audit-service integration in identity-service, auth-service, governance-role-service] -- does a citizen-facing action still complete when the audit call fails?",
);
